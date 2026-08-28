import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

import type { PresenceView } from '#src/generated/PresenceView';
import type { CoreClient } from '#lib/core/client.svelte.js';

export interface PresenceEntry {
  presence: PresenceView;
  statusMessage: string | null;
  lastActiveAgo: number | null;
  receivedAt: number;
}

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
  #stopEvents: (() => void) | null = null;

  start(core: CoreClient): void {
    this.#stopEvents?.();
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
  }

  get(userId: string): PresenceEntry | null {
    return this.#entries.get(userId) ?? null;
  }
}

export const [usePresenceStore, providePresenceStore] = createContext<PresenceStore>();
