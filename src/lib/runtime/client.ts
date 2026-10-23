import type {
  AppEvent,
  Batch,
  Outcome,
  ReplyError,
  ReqId,
  SubId,
  Target,
  Window,
} from '#src/generated/protocol';
import { WireMismatchError, checkHandshake } from './handshake';
import type { Link } from './link';
import { Subscription, type Host } from './subscription';

export class RequestError extends Error {
  constructor(readonly reason: ReplyError | { kind: 'restarted' }) {
    super(`The request failed: ${reason.kind}`);
    this.name = 'RequestError';
  }
}

export interface ClientOptions {
  /** Slices the UI needs; a runtime without one is a mismatch. */
  needed?: readonly string[];
  /** Where failures nobody awaits end up, such as a resync that failed. */
  onError?: (error: unknown) => void;
}

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

type Notice = Extract<AppEvent, { type: 'notice' }>;

/** @throws {WireMismatchError} when the runtime was not built from this UI's source. */
export async function connect(link: Link, options: ClientOptions = {}): Promise<Client> {
  const client = new Client(link, options);
  await client.check();
  return client;
}

export class Client implements Host {
  generation = 0;
  readonly onError: (error: unknown) => void;
  #subscriptions = new Set<Subscription<unknown>>();
  #byId = new Map<SubId, Subscription<unknown>>();
  #early: Extract<AppEvent, { type: 'patch' | 'resync' }>[] = [];
  #opening = 0;
  #requests = new Map<ReqId, Waiting>();
  #earlyReplies = new Map<ReqId, Outcome>();
  #issuing = 0;
  #notices = new Set<(notice: Notice) => void>();
  #epoch = 0;

  constructor(
    readonly link: Link,
    private readonly options: ClientOptions
  ) {
    this.onError = options.onError ?? console.error;
    link.onBatch((batch) => {
      this.#apply(batch);
    });
    link.onRestart?.(() => {
      this.reconnect().catch(this.onError);
    });
  }

  async check(): Promise<void> {
    const mismatch = checkHandshake(await this.link.handshake(), this.options.needed);
    if (mismatch) throw new WireMismatchError(mismatch);
  }

  subscribe<S>(target: Target, window: Window | null = null): Subscription<S> {
    const subscription = new Subscription<S>(target, window, this);
    this.#subscriptions.add(subscription);
    return subscription;
  }

  dispatch(target: Target, action: unknown): Promise<void> {
    return this.link.dispatch(target, action);
  }

  request(target: Target, action: unknown): Promise<unknown> {
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      this.#issuing++;
      this.link
        .request(target, action)
        .then((req) => {
          const early = this.#earlyReplies.get(req);
          if (generation !== this.generation) {
            reject(new RequestError({ kind: 'restarted' }));
          } else if (early) {
            settle(early, { resolve, reject });
          } else {
            this.#requests.set(req, { resolve, reject });
          }
        }, reject)
        .finally(() => {
          if (--this.#issuing === 0) this.#earlyReplies.clear();
        });
    });
  }

  onNotice(listener: (notice: Notice) => void): () => void {
    this.#notices.add(listener);
    return () => this.#notices.delete(listener);
  }

  /** Call after the runtime restarted. Pending requests are rejected and every subscription subscribes again. */
  async reconnect(): Promise<void> {
    this.generation++;
    this.#epoch = 0;
    this.#early = [];
    this.#byId.clear();
    this.#earlyReplies.clear();
    const waiting = [...this.#requests.values()];
    this.#requests.clear();
    for (const { reject } of waiting) reject(new RequestError({ kind: 'restarted' }));
    await this.check();
    for (const subscription of this.#subscriptions) {
      subscription.reset();
      subscription.open().catch(this.onError);
    }
  }

  track(sub: SubId, subscription: Subscription<unknown>): void {
    this.#byId.set(sub, subscription);
  }

  untrack(sub: SubId): void {
    this.#byId.delete(sub);
  }

  forget(subscription: Subscription<unknown>): void {
    this.#subscriptions.delete(subscription);
  }

  replay(sub: SubId): void {
    const mine = this.#early.filter((event) => event.sub === sub);
    this.#early = this.#early.filter((event) => event.sub !== sub);
    for (const event of mine) this.#byId.get(sub)?.apply(event);
  }

  opening(): () => void {
    this.#opening++;
    return () => {
      if (--this.#opening === 0) this.#early = [];
    };
  }

  #apply(batch: Batch): void {
    const touched = new Set<Subscription<unknown>>();
    for (const event of batch.events) {
      if (event.epoch > this.#epoch && event.type !== 'reply') this.#epoch = event.epoch;
      switch (event.type) {
        case 'patch':
        case 'resync': {
          const subscription = this.#byId.get(event.sub);
          if (subscription) {
            subscription.apply(event);
            touched.add(subscription);
          } else if (this.#opening > 0) {
            this.#early.push(event);
          }
          break;
        }
        case 'reply':
          this.#answer(event.req, event.outcome);
          break;
        case 'notice':
          if (event.epoch >= this.#epoch) for (const listener of this.#notices) listener(event);
          break;
      }
    }
    for (const subscription of touched) subscription.notify();
  }

  #answer(req: ReqId, outcome: Outcome): void {
    const waiting = this.#requests.get(req);
    if (waiting) {
      this.#requests.delete(req);
      settle(outcome, waiting);
    } else if (this.#issuing > 0) {
      this.#earlyReplies.set(req, outcome);
    }
  }
}

function settle(outcome: Outcome, { resolve, reject }: Waiting): void {
  if (outcome.status === 'ok') resolve(outcome.value);
  else reject(new RequestError(outcome.error));
}
