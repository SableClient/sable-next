import type { NotificationView } from '#src/generated/NotificationView';

import { presentsInApp } from '#lib/platform/notifications.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

export function enabled(): boolean {
  return presentsInApp() && preferences.desktopNotifications && permission() === 'granted';
}

export function permission(): NotificationPermission {
  return presentsInApp() ? Notification.permission : 'denied';
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!presentsInApp()) return 'denied';
  return Notification.requestPermission();
}

export function title(view: NotificationView): string {
  return view.room_name;
}

export function body(view: NotificationView): string {
  if (!preferences.notificationContent) {
    return view.is_direct ? 'New message' : `New message from ${sender(view)}`;
  }
  return view.is_direct ? view.body : `${sender(view)}: ${view.body}`;
}

function sender(view: NotificationView): string {
  return view.sender_name ?? view.sender;
}

export function tag(view: NotificationView): string {
  return `${view.user_id} ${view.room_id}`;
}
