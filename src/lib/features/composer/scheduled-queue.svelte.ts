import { SvelteMap } from 'svelte/reactivity';

export interface QueuedMessage {
  id: string;
  roomId: string;
  body: string;
  formatted: string | null;
  dueTs: number;
  owner: string;
}

const TAKEOVER_MS = 5 * 60 * 1000;

const queues = new SvelteMap<string, readonly QueuedMessage[]>();
const EMPTY: readonly QueuedMessage[] = [];

export function scheduledQueue(accountId = ''): readonly QueuedMessage[] {
  return queues.get(accountId) ?? EMPTY;
}

export function queueFor(roomId: string, accountId = ''): QueuedMessage[] {
  return scheduledQueue(accountId).filter((message) => message.roomId === roomId);
}

export function enqueue(message: QueuedMessage, accountId = ''): void {
  adoptQueue([...scheduledQueue(accountId), message], accountId);
}

export function dequeue(id: string, accountId = ''): void {
  adoptQueue(
    scheduledQueue(accountId).filter((message) => message.id !== id),
    accountId
  );
}

export function adoptQueue(next: readonly QueuedMessage[], accountId = ''): void {
  queues.set(accountId, [...next]);
}

export function dueMessages(now: number, deviceId: string, accountId = ''): QueuedMessage[] {
  return scheduledQueue(accountId).filter((message) => {
    if (message.owner === deviceId) return message.dueTs <= now;
    return message.dueTs + TAKEOVER_MS <= now;
  });
}

export function parseQueue(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const { id, roomId, body, dueTs, owner, formatted } = record;
    if (
      typeof id !== 'string' ||
      typeof roomId !== 'string' ||
      typeof body !== 'string' ||
      typeof dueTs !== 'number' ||
      typeof owner !== 'string'
    ) {
      return [];
    }

    return [
      {
        id,
        roomId,
        body,
        formatted: typeof formatted === 'string' ? formatted : null,
        dueTs,
        owner,
      },
    ];
  });
}
