export interface QueuedMessage {
  id: string;
  roomId: string;
  body: string;
  formatted: string | null;
  dueTs: number;
  owner: string;
}

const TAKEOVER_MS = 5 * 60 * 1000;

let queue = $state.raw<QueuedMessage[]>([]);

export function scheduledQueue(): readonly QueuedMessage[] {
  return queue;
}

export function queueFor(roomId: string): QueuedMessage[] {
  return queue.filter((message) => message.roomId === roomId);
}

export function enqueue(message: QueuedMessage): void {
  queue = [...queue, message];
}

export function dequeue(id: string): void {
  queue = queue.filter((message) => message.id !== id);
}

export function adoptQueue(next: readonly QueuedMessage[]): void {
  queue = [...next];
}

export function dueMessages(now: number, deviceId: string): QueuedMessage[] {
  return queue.filter((message) => {
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
