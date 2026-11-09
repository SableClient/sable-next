import {
  dismissNativeReadRoomNotifications,
  dismissNativeRoomNotifications,
} from '#lib/platform/native-notifications.js';

import { isRingingCall, type PresentedAlertData } from './call-alert';
import { roomTag } from './tag';

export async function retireRoomAlerts(userId: string, roomIds: readonly string[]): Promise<void> {
  if (roomIds.length === 0) return;

  await Promise.all([
    dismissNativeRoomNotifications(userId, roomIds),
    closePresented(userId, new Set(roomIds)),
  ]);
}

export async function retireReadAlerts(userId: string, roomIds: readonly string[]): Promise<void> {
  if (roomIds.length === 0) return;

  await Promise.all([
    dismissNativeReadRoomNotifications(userId, roomIds),
    closePresented(userId, new Set(roomIds)),
  ]);
}

async function closePresented(userId: string, roomIds: ReadonlySet<string>): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration().catch((error: unknown) => {
    console.debug('[sable notifications] service worker registration unavailable', error);
    return undefined;
  });
  if (registration === undefined || !('getNotifications' in registration)) return;

  const tags = new Set([...roomIds].map((roomId) => roomTag(userId, roomId)));
  for (const notification of await registration.getNotifications()) {
    const data = notification.data as PresentedAlertData | undefined;
    if (isRingingCall(data)) continue;
    const postedForRoom =
      typeof data?.roomId === 'string' &&
      roomIds.has(data.roomId) &&
      (data.userId === undefined || data.userId === userId);
    if (postedForRoom || tags.has(notification.tag)) notification.close();
  }
}
