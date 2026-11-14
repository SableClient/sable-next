import { isRecord } from '#lib/guards.js';

export type WorkerMessage =
  | {
      type: 'sable:push-event';
      roomId: string;
      eventId: string;
      userId: string;
      serverUserId: string | null;
    }
  | { type: 'sable:push-resubscribe' }
  | { type: 'sable:webpush-ack'; appId: string; ackToken: string }
  | { type: 'sable:open-invites'; userId: string | null }
  | { type: 'sable:invite-action'; roomId: string; userId: string; outcome: 'accept' | 'decline' }
  | {
      type: 'sable:call-action';
      roomId: string;
      userId: string;
      eventId: string | null;
      outcome: 'answer' | 'decline';
    }
  | { type: 'sable:open-room'; roomId: string; userId: string | null; eventId: string | null }
  | { type: 'sable:server-user' }
  | { type: 'sable:share'; serverUserId: string | null; text: string; files: File[] };

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function parseWorkerMessage(data: unknown): WorkerMessage | null {
  if (!isRecord(data)) return null;
  const roomId = text(data.roomId);
  const userId = text(data.userId);
  const eventId = text(data.eventId);
  const { outcome } = data;
  switch (data.type) {
    case 'sable:push-event':
      return roomId !== null && eventId !== null && userId !== null
        ? { type: data.type, roomId, eventId, userId, serverUserId: text(data.serverUserId) }
        : null;
    case 'sable:push-resubscribe':
    case 'sable:server-user':
      return { type: data.type };
    case 'sable:webpush-ack': {
      const appId = text(data.appId);
      const ackToken = text(data.ackToken);
      return appId && ackToken ? { type: data.type, appId, ackToken } : null;
    }
    case 'sable:open-invites':
      return { type: data.type, userId };
    case 'sable:invite-action':
      return roomId !== null && userId !== null && (outcome === 'accept' || outcome === 'decline')
        ? { type: data.type, roomId, userId, outcome }
        : null;
    case 'sable:call-action':
      return roomId !== null && userId !== null && (outcome === 'answer' || outcome === 'decline')
        ? { type: data.type, roomId, userId, eventId, outcome }
        : null;
    case 'sable:open-room':
      return roomId !== null ? { type: data.type, roomId, userId, eventId } : null;
    case 'sable:share':
      return {
        type: data.type,
        serverUserId: text(data.serverUserId),
        text: text(data.text) ?? '',
        files: Array.isArray(data.files)
          ? data.files.filter((file): file is File => file instanceof File)
          : [],
      };
    default:
      return null;
  }
}
