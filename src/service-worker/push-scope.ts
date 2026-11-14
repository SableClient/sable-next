import type { PushSession } from '#lib/notifications/room-names.js';
import type { WorkerMessage } from '#lib/notifications/worker-message.js';

export async function belongsToServerUser(
  userId: string | null | undefined,
  lookup: (userId: string) => Promise<PushSession | null>
): Promise<boolean> {
  if (!userId) return false;
  const session = await lookup(userId);
  return session?.userId === userId;
}

export function clientHasServerIdentity(
  client: { postMessage(message: unknown, transfer: Transferable[]): void },
  identity: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 500);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data === identity);
    };
    try {
      client.postMessage({ type: 'sable:server-user' } satisfies WorkerMessage, [channel.port2]);
    } catch {
      clearTimeout(timer);
      channel.port1.close();
      resolve(false);
    }
  });
}
