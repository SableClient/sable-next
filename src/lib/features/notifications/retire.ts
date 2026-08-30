import { dismissNativeRoomNotification } from '#lib/platform/native-notifications.js';

import { roomTag } from './tag';

export async function retireRoomAlerts(userId: string, roomId: string): Promise<void> {
  await Promise.all([
    dismissNativeRoomNotification(userId, roomId),
    closePresented(roomTag(userId, roomId)),
  ]);
}

async function closePresented(tag: string): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (registration === undefined) return;

  for (const notification of await registration.getNotifications({ tag })) notification.close();
}
