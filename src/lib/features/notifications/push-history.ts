import type { PushPayload } from './push-payload';

export interface PushHistoryEntry {
  at: number;
  outcome: string;
  userId?: string;
  roomId?: string;
  eventId?: string;
}

export const PUSH_HISTORY_LIMIT = 200;
export const DIAGNOSTIC_EVENT_PREFIX = '$sable-diagnostic-';

export function isDiagnosticPush(payload: PushPayload): boolean {
  return payload.notification?.event_id?.startsWith(DIAGNOSTIC_EVENT_PREFIX) ?? false;
}

export function pushTrace(
  payload: PushPayload | undefined
): Pick<PushHistoryEntry, 'userId' | 'roomId' | 'eventId'> {
  const notification = payload?.notification;
  return {
    ...(notification?.user_id ? { userId: notification.user_id } : {}),
    ...(notification?.room_id ? { roomId: notification.room_id } : {}),
    ...(notification?.event_id ? { eventId: notification.event_id } : {}),
  };
}

export function appendPushEntry(
  history: readonly PushHistoryEntry[],
  entry: PushHistoryEntry
): PushHistoryEntry[] {
  return [...history, entry].slice(-PUSH_HISTORY_LIMIT);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function readPushHistory(stored: unknown): PushHistoryEntry[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const outcome = text(record.outcome);
    if (typeof record.at !== 'number' || outcome === undefined) return [];
    const userId = text(record.userId);
    const roomId = text(record.roomId);
    const eventId = text(record.eventId);
    return [
      {
        at: record.at,
        outcome,
        ...(userId ? { userId } : {}),
        ...(roomId ? { roomId } : {}),
        ...(eventId ? { eventId } : {}),
      },
    ];
  });
}
