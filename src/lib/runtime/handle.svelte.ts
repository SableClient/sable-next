import type { Slices, Window } from '#src/generated/protocol';
import { CoreError } from '#src/transport';

import { runtime } from './app.js';
import { RequestError, type Client } from './client.js';
import { reactive } from './reactive.svelte.js';
import type { Subscription } from './subscription.js';

type SliceName = keyof Slices;
type ActionOf<K extends SliceName> = Slices[K]['action'];

/** What the requests of a slice answer with, by the `type` of the action. */
export type Replies<K extends SliceName> = { [T in ActionOf<K>['type']]?: unknown };

export interface HandleOptions<K extends SliceName> {
  /** The part of a list the subscription follows; all of it when `null`. */
  window?: Window | null;
  /** Runs once each snapshot that a subscribe, or a new one after a restart, has brought is in. */
  onOpen?: () => void;
  /** Runs for every batch that changed the view. */
  onChange?: () => void;
  /** Runs for each notice the slice sends. */
  onNotice?: (notice: Slices[K]['notice']) => void;
}

/**
 * One slice instance as the UI uses it: its view, the actions sent to it and the requests it
 * answers. `open` and `close` can follow each other any number of times. `R` types what each
 * request answers.
 */
export class SliceHandle<K extends SliceName, R extends Replies<K> = Replies<K>> {
  #live = $state.raw<{ readonly current: Slices[K]['view'] | undefined } | null>(null);
  #subscription: Subscription<Slices[K]['view']> | null = null;
  #started: Promise<Client> | null = null;
  #connection: Promise<Client> | null = null;
  #client: Client | null = null;
  #generation = 0;
  readonly #release: (() => void)[] = [];

  constructor(
    readonly slice: K,
    readonly key: Slices[K]['key'],
    private readonly connect: () => Promise<Client> = runtime,
    private readonly options: HandleOptions<K> = {}
  ) {}

  get view(): Slices[K]['view'] | undefined {
    return this.#live?.current;
  }

  /** Subscribes unless it already has, and resolves once the first view is in. A failure can be tried again. */
  async open(): Promise<void> {
    const started = (this.#started ??= this.#subscribe());
    try {
      await started;
    } catch (error) {
      if (this.#started === started) {
        this.#started = null;
        this.#connection = null;
      }
      throw error;
    }
  }

  close(): void {
    this.#generation += 1;
    this.#started = null;
    this.#connection = null;
    this.#client = null;
    for (const release of this.#release.splice(0)) release();
    const subscription = this.#subscription;
    this.#subscription = null;
    this.#live = null;
    subscription?.close().catch((error: unknown) => {
      console.debug('[sable runtime] slice not closed', this.slice, error);
    });
  }

  /** Do not keep actions in a page that may navigate away while its initial snapshot loads. */
  async dispatch(action: ActionOf<K>): Promise<void> {
    const client = this.#client ?? (await (this.#connection ?? this.connect()));
    await client.dispatch(this.#target(), action);
  }

  /** Sends an action at once if the handle is open, and drops it while it is not. */
  send(action: ActionOf<K>): void {
    this.#client?.dispatch(this.#target(), action).catch((error: unknown) => {
      console.debug('[sable runtime] action not sent', this.slice, error);
    });
  }

  /** Resolves with what the slice answers. A call the core refused throws the `CoreError` it would have thrown as a direct call. */
  async request<T extends keyof R & ActionOf<K>['type']>(
    action: Extract<ActionOf<K>, { type: T }>
  ): Promise<R[T]> {
    try {
      return (await (await this.#ready()).request(this.#target(), action)) as R[T];
    } catch (error) {
      if (error instanceof RequestError && error.reason.kind === 'rpc') {
        throw new CoreError(error.reason.error);
      }
      throw error;
    }
  }

  /** Moves the part of a list the view follows, `null` for all of it. */
  async range(window: Window | null): Promise<void> {
    await this.#subscription?.range(window);
  }

  #target(): { slice: string; key: unknown } {
    return { slice: this.slice, key: this.key };
  }

  #ready(): Promise<Client> {
    return this.#started ?? this.connect();
  }

  async #subscribe(): Promise<Client> {
    const generation = this.#generation;
    const client = await (this.#connection = this.connect());
    if (generation !== this.#generation) return client;
    this.#client = client;
    const { window = null, onOpen, onChange, onNotice } = this.options;
    const subscription = client.subscribe<Slices[K]['view']>(this.#target(), window);
    this.#subscription = subscription;
    this.#live = reactive(subscription);
    if (onChange) this.#release.push(subscription.subscribe(onChange));
    if (onOpen) this.#release.push(subscription.onOpen(onOpen));
    if (onNotice) {
      this.#release.push(
        client.onNotice((notice) => {
          if (notice.slice === this.slice) onNotice(notice.notice as Slices[K]['notice']);
        })
      );
    }
    try {
      await subscription.loaded;
    } catch (error) {
      if (generation === this.#generation) this.close();
      throw error;
    }
    return client;
  }
}
