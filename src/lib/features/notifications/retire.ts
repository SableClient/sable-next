import {
  dismissNativeReadRoomNotifications,
  dismissNativeRoomNotification,
} from '#lib/platform/native-notifications.js';

import { roomTag } from './tag';

export async function retireRoomAlerts(userId: string, roomId: string): Promise<void> {
  await Promise.all([
    dismissNativeRoomNotification(userId, roomId),
    closePresented(new Set([roomTag(userId, roomId)])),
  ]);
}

export async function retireReadAlerts(userId: string, roomIds: readonly string[]): Promise<void> {
  if (roomIds.length === 0) return;

  await Promise.all([
    dismissNativeReadRoomNotifications(userId, roomIds),
    closePresented(new Set(roomIds.map((roomId) => roomTag(userId, roomId)))),
  ]);
}

async function closePresented(tags: ReadonlySet<string>): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (registration === undefined) return;

  for (const notification of await registration.getNotifications()) {
    if (tags.has(notification.tag)) notification.close();
  }
}
