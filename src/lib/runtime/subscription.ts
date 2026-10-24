import type { AppEvent, Snapshot, SubId, Target, Window } from '#src/generated/protocol';
import type { Link } from './link';
import { applyOps } from './patch';

type Patch = Extract<AppEvent, { type: 'patch' }>;
type SubEvent = Patch | Extract<AppEvent, { type: 'resync' }>;

export interface Host {
  readonly link: Link;
  /** Counts the connections made, so work started on an earlier one can tell. */
  readonly generation: number;
  readonly onError: (error: unknown) => void;
  track(sub: SubId, subscription: Subscription<unknown>): void;
  untrack(sub: SubId): void;
  forget(subscription: Subscription<unknown>): void;
  replay(sub: SubId): void;
  opening(): () => void;
}

/** `get` keeps its identity until a batch changes it, and `subscribe` hears once per such batch, as `useSyncExternalStore` expects. */
export class Subscription<S> {
  /** Resolves once the first snapshot is in, and rejects if the first subscribe fails. */
  readonly loaded: Promise<void>;
  #loadedNow: () => void = () => undefined;
  #loadedFailed: (error: unknown) => void = () => undefined;
  #state: S | undefined;
  #rev = 0;
  #epoch = 0;
  #sub: SubId | undefined;
  #window: Window | null;
  #listeners = new Set<() => void>();
  #openers = new Set<() => void>();
  #dirty = false;
  #closed = false;
  #held: SubEvent[] | null = null;
  #pending = 0;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly target: Target,
    window: Window | null,
    private readonly host: Host
  ) {
    this.#window = window;
    this.loaded = new Promise((resolve, reject) => {
      this.#loadedNow = resolve;
      this.#loadedFailed = reject;
    });
    this.loaded.catch(() => undefined);
    this.open().catch(this.#loadedFailed);
  }

  get = (): S | undefined => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Runs after the state arrives from a new subscribe, at first and after a restart. */
  onOpen(listener: () => void): () => void {
    this.#openers.add(listener);
    return () => this.#openers.delete(listener);
  }

  /** Moves the part of a list the subscription follows, `null` for all of it. */
  async range(window: Window | null): Promise<void> {
    await this.loaded;
    this.#window = window;
    await this.#refresh((sub) => this.host.link.range(sub, window));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.host.forget(this);
    const sub = this.#sub;
    if (sub === undefined) return;
    this.#sub = undefined;
    this.host.untrack(sub);
    await this.host.link.unsubscribe(sub);
  }

  /** The state stays until the new snapshot replaces it. */
  async open(): Promise<void> {
    const generation = this.host.generation;
    const done = this.host.opening();
    try {
      const subscribed = await this.host.link
        .subscribe({ ...this.target, window: this.#window })
        .catch((error: unknown) => {
          // A restart rejects what was in flight; the new connection subscribes again.
          if (generation === this.host.generation) throw error;
          return null;
        });
      if (!subscribed || generation !== this.host.generation) return;
      const { sub, snapshot } = subscribed;
      if (this.#closed) {
        await this.host.link.unsubscribe(sub);
        return;
      }
      this.#sub = sub;
      this.host.track(sub, this);
      this.#load(snapshot);
      this.host.replay(sub);
      this.notify();
      for (const listener of this.#openers) listener();
      this.#loadedNow();
    } finally {
      done();
    }
  }

  reset(): void {
    this.#sub = undefined;
    this.#held = null;
    this.#pending = 0;
    this.#chain = Promise.resolve();
  }

  apply(event: SubEvent): void {
    if (event.epoch < this.#epoch) return;
    if (event.type === 'resync') {
      this.#resync();
    } else if (this.#held) {
      this.#held.push(event);
    } else if (event.epoch > this.#epoch || event.rev > this.#rev + 1) {
      this.#resync();
    } else if (event.rev > this.#rev) {
      try {
        this.#state = applyOps(this.#state, event.ops) as S;
        this.#rev = event.rev;
        this.#dirty = true;
      } catch (error) {
        this.host.onError(error);
        this.#resync();
      }
    }
  }

  notify(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    for (const listener of this.#listeners) listener();
  }

  #load(snapshot: Snapshot): void {
    this.#state = snapshot.state as S;
    this.#rev = snapshot.rev;
    this.#epoch = snapshot.epoch;
    this.#dirty = true;
  }

  #resync(): void {
    this.#refresh((sub) => this.host.link.resync(sub)).catch(this.host.onError);
  }

  #refresh(call: (sub: SubId) => Promise<Snapshot>): Promise<void> {
    const generation = this.host.generation;
    this.#pending++;
    this.#held ??= [];
    const run = this.#chain.then(async () => {
      try {
        if (this.#sub === undefined) return;
        const snapshot = await call(this.#sub);
        if (generation === this.host.generation) this.#load(snapshot);
      } finally {
        if (generation === this.host.generation && --this.#pending === 0) this.#release();
      }
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #release(): void {
    const held = this.#held ?? [];
    this.#held = null;
    for (const event of held) this.apply(event);
    this.notify();
  }
}
