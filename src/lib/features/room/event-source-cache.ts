import { isRecord } from '#lib/guards.js';

const MAX_ENTRIES = 256;

const sources = new Map<string, Promise<Record<string, unknown> | null>>();

export function readEventSource(
  read: (roomId: string, eventId: string) => Promise<string>,
  roomId: string,
  eventId: string
): Promise<Record<string, unknown> | null> {
  const key = `${roomId}\u0000${eventId}`;
  const cached = sources.get(key);
  if (cached) return cached;
  if (sources.size >= MAX_ENTRIES) sources.clear();
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
