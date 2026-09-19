import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

import type { PresenceView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

export interface PresenceEntry {
  presence: PresenceView;
  statusMessage: string | null;
  lastActiveAgo: number | null;
  receivedAt: number;
}

const FETCH_DELAY_MS = 50;

export type LastSeenBucket =
  | { kind: 'now' }
  | { kind: 'minutes'; count: number }
  | { kind: 'hours'; count: number }
  | { kind: 'days'; count: number };

export function lastSeenMs(
  entry: Pick<PresenceEntry, 'lastActiveAgo' | 'receivedAt'>,
  now: number
): number | null {
  if (entry.lastActiveAgo === null) return null;
  return Math.max(0, entry.lastActiveAgo + (now - entry.receivedAt));
}

export function lastSeenBucket(msAgo: number): LastSeenBucket {
  const minutes = Math.floor(msAgo / 60_000);
  if (minutes < 1) return { kind: 'now' };
  if (minutes < 60) return { kind: 'minutes', count: minutes };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: 'hours', count: hours };

  return { kind: 'days', count: Math.floor(hours / 24) };
}

export class PresenceStore {
  readonly #entries = new SvelteMap<string, PresenceEntry>();
  /* Nothing renders from these, and a reactive set would re-run every mounted
     presence reader on any other user's first look. */
  /* eslint-disable svelte/prefer-svelte-reactivity */
  readonly #requested = new Set<string>();
  readonly #pending = new Set<string>();
  /* eslint-enable svelte/prefer-svelte-reactivity */
  #core: CoreClient | null = null;
  #flush: ReturnType<typeof setTimeout> | null = null;
  #stopEvents: (() => void) | null = null;

  start(core: CoreClient): void {
    this.#stopEvents?.();
    this.#core = core;
    this.#stopEvents = core.subscribeEvents((event) => {
      if (event.type !== 'presence') return;

      this.#entries.set(event.user_id, {
        presence: event.presence,
        statusMessage: event.status_message,
        lastActiveAgo: event.last_active_ago,
        receivedAt: Date.now(),
      });
    });
  }

  stop(): void {
    this.#stopEvents?.();
    this.#stopEvents = null;
    this.#core = null;
    if (this.#flush !== null) clearTimeout(this.#flush);
    this.#flush = null;
    this.#pending.clear();
    this.#requested.clear();
    this.#entries.clear();
  }

  get(userId: string): PresenceEntry | null {
    const entry = this.#entries.get(userId);
    if (entry) return entry;

    this.#request(userId);
    return null;
  }

  peek(userId: string): PresenceEntry | null {
    return this.#entries.get(userId) ?? null;
  }

  #request(userId: string): void {
    if (this.#core === null || this.#requested.has(userId)) return;

    this.#requested.add(userId);
    this.#pending.add(userId);
    this.#flush ??= setTimeout(() => {
      this.#flush = null;
      const userIds = [...this.#pending];
      this.#pending.clear();
      void this.#core?.commands.fetchPresence(userIds).catch(() => {});
    }, FETCH_DELAY_MS);
  }
}

export const [usePresenceStore, providePresenceStore] = createContext<PresenceStore>();
