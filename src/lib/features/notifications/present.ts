import type { NotificationView } from '#src/generated/NotificationView';

import { presentsInApp } from '#lib/platform/notifications.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import type { ConversationLine } from './conversation';
import { roomTag } from './tag';

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

function showsContent(view: NotificationView): boolean {
  return (
    preferences.notificationContent && (!view.encrypted || preferences.notificationEncryptedContent)
  );
}

export function body(view: NotificationView): string {
  if (!showsContent(view)) {
    return view.is_direct ? 'New message' : `New message from ${sender(view)}`;
  }
  return view.is_direct ? view.body : `${sender(view)}: ${view.body}`;
}

export function line(view: NotificationView): ConversationLine {
  if (!showsContent(view)) return { sender: null, body: body(view), eventId: view.event_id };
  return {
    sender: view.is_direct ? null : sender(view),
    body: view.body,
    eventId: view.event_id,
  };
}

function sender(view: NotificationView): string {
  return view.sender_name ?? view.sender;
}

export function tag(view: NotificationView): string {
  return roomTag(view.user_id, view.room_id);
}
