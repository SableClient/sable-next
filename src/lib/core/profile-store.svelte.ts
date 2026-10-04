import QuickLRU from 'quick-lru';
import { createSubscriber } from 'svelte/reactivity';

import type { ProfileView } from '#src/generated/protocol';

import { CoreError } from '../../transport';

const MAX_ENTRIES = 256;
const FRESH_MS = 2 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;
const RETRY_BACKOFF_MS = [3000, 10_000, 30_000];
const CHANGE_COALESCE_MS = 500;

interface Entry {
  accountId: string | null;
  profile: ProfileView;
  fetchedAt: number;
}

interface Failure {
  accountId: string | null;
  error: unknown;
  attempts: number;
  retryAt: number;
}

interface Source {
  accountId: () => string | null;
  fetch: (userId: string) => Promise<ProfileView>;
}

class Signal {
  #update: (() => void) | null = null;
  readonly #subscribe: () => void;

  constructor(onIdle: () => void) {
    this.#subscribe = createSubscriber((update) => {
      this.#update = update;
      return () => {
        this.#update = null;
        onIdle();
      };
    });
  }

  track(): void {
    this.#subscribe();
  }

  notify(): void {
    this.#update?.();
  }
}

/* eslint-disable svelte/prefer-svelte-reactivity */
export class ProfileStore {
  readonly #entries = new QuickLRU<string, Entry>({ maxSize: MAX_ENTRIES });
  readonly #failures = new QuickLRU<string, Failure>({ maxSize: MAX_ENTRIES });
  readonly #requests = new Map<
    string,
    { accountId: string | null; request: Promise<ProfileView> }
  >();
  readonly #signals = new Map<string, Signal>();
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #changed = new Set<string>();
  #changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly source: Source) {}

  get(userId: string | null): ProfileView | null {
    if (userId === null) return null;
    this.#signal(userId).track();
    void this.load(userId).catch(() => {});
    return this.#current(userId)?.profile ?? null;
  }

  peek(userId: string): ProfileView | null {
    return this.#current(userId)?.profile ?? null;
  }

  async load(userId: string): Promise<ProfileView> {
    const accountId = this.source.accountId();
    const entry = this.#current(userId);
    if (entry && Date.now() - entry.fetchedAt < FRESH_MS) return entry.profile;

    const pending = this.#requests.get(userId);
    if (pending?.accountId === accountId) return pending.request;

    const failure = this.#failures.get(userId);
    if (failure?.accountId === accountId && Date.now() < failure.retryAt) {
      throw failure.error;
    }

    return this.#request(userId, accountId, failure?.attempts ?? 0);
  }

  invalidate(userId: string): void {
    const entry = this.#entries.get(userId);
    if (entry) entry.fetchedAt = 0;
    this.#failures.delete(userId);
    this.#requests.delete(userId);
    this.#changed.add(userId);
    this.#changeTimer ??= setTimeout(() => {
      this.#changeTimer = null;
      const changed = [...this.#changed];
      this.#changed.clear();
      for (const id of changed) this.#signals.get(id)?.notify();
    }, CHANGE_COALESCE_MS);
  }

  clear(): void {
    this.#entries.clear();
    this.#failures.clear();
    this.#requests.clear();
    this.#changed.clear();
    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    this.#changeTimer = null;
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
  }

  #current(userId: string): Entry | undefined {
    const entry = this.#entries.get(userId);
    return entry?.accountId === this.source.accountId() ? entry : undefined;
  }

  #signal(userId: string): Signal {
    let signal = this.#signals.get(userId);
    if (!signal) {
      signal = new Signal(() => this.#signals.delete(userId));
      this.#signals.set(userId, signal);
    }
    return signal;
  }

  #request(userId: string, accountId: string | null, attempts: number): Promise<ProfileView> {
    const request = this.source.fetch(userId).then(
      (profile) => {
        if (this.#requests.get(userId)?.request === request) {
          this.#failures.delete(userId);
          this.#entries.set(userId, { accountId, profile, fetchedAt: Date.now() });
          this.#signals.get(userId)?.notify();
        }
        return profile;
      },
      (error: unknown) => {
        if (this.#requests.get(userId)?.request === request) {
          this.#fail(userId, accountId, error, attempts + 1);
        }
        throw error;
      }
    );
    this.#requests.set(userId, { accountId, request });
    const settle = () => {
      if (this.#requests.get(userId)?.request === request) this.#requests.delete(userId);
    };
    void request.then(settle, settle);
    return request;
  }

  #fail(userId: string, accountId: string | null, error: unknown, attempts: number): void {
    const rateLimited = error instanceof CoreError && error.detail.code === 'rate_limited';
    this.#failures.set(userId, {
      accountId,
      error,
      attempts,
      retryAt: rateLimited ? 0 : Date.now() + FAILURE_RETRY_MS,
    });
    this.#scheduleRetry(userId, attempts, rateLimited);
  }

  #scheduleRetry(userId: string, attempts: number, rateLimited: boolean): void {
    if (attempts > RETRY_BACKOFF_MS.length) return;
    const backoff = RETRY_BACKOFF_MS[attempts - 1];
    clearTimeout(this.#retries.get(userId));
    const timer = setTimeout(
      () => {
        this.#retries.delete(userId);
        this.#signals.get(userId)?.notify();
      },
      rateLimited ? backoff : Math.max(backoff, FAILURE_RETRY_MS)
    );
    this.#retries.set(userId, timer);
  }
}
