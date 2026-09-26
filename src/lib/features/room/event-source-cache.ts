import QuickLRU from 'quick-lru';

import { isRecord } from '#lib/guards.js';

const MAX_ENTRIES = 256;

const sources = new QuickLRU<string, Promise<Record<string, unknown> | null>>({
  maxSize: MAX_ENTRIES,
});

export function readEventSource(
  read: (roomId: string, eventId: string) => Promise<string>,
  roomId: string,
  eventId: string
): Promise<Record<string, unknown> | null> {
  const key = `${roomId}\u0000${eventId}`;
  const cached = sources.get(key);
  if (cached) return cached;
  const pending = read(roomId, eventId)
    .then((source) => {
      const event: unknown = JSON.parse(source);
      return isRecord(event) ? event : null;
    })
    .catch(() => {
      sources.delete(key);
      return null;
    });
  sources.set(key, pending);
  return pending;
}
