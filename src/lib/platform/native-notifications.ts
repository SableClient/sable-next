import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core';

export interface NativeNotificationTarget {
  userId: string;
  roomId: string;
  eventId: string | null;
}

export interface NativeNotificationAction extends NativeNotificationTarget {
  actionId: string;
  text: string | null;
}

export function alertsNatively(): boolean {
  return isTauri();
}

export async function dismissNativeRoomNotification(userId: string, roomId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('dismiss_room_notification', { userId, roomId });
}

export async function setNativeEncryptedContentAllowed(allowed: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_notification_encrypted_content', { allowed });
}

export async function sendNativeTestNotification(sequence: number): Promise<void> {
  await invoke('test_notification', { sequence });
}

export async function watchNativeNotificationActions(
  handler: (action: NativeNotificationAction) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};

  const listener = await addPluginListener('notifications', 'actionPerformed', (event: unknown) => {
    const action = readAction(event);
    if (action !== null) handler(action);
  });
  await invoke('plugin:notifications|set_action_listener_active', { active: true });

  return () => {
    void invoke('plugin:notifications|set_action_listener_active', { active: false }).catch(
      () => undefined
    );
    void listener.unregister().catch(() => undefined);
  };
}

export async function watchNativeNotificationClicks(
  handler: (target: NativeNotificationTarget) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};

  const listener = await addPluginListener(
    'notifications',
    'notificationClicked',
    (event: unknown) => {
      const target = readTarget((event as { data?: unknown } | undefined)?.data);
      if (target !== null) handler(target);
    }
  );
  await invoke('plugin:notifications|set_click_listener_active', { active: true });

  return () => {
    void invoke('plugin:notifications|set_click_listener_active', { active: false }).catch(
      () => undefined
    );
    void listener.unregister().catch(() => undefined);
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function readTarget(value: unknown): NativeNotificationTarget | null {
  if (value === null || typeof value !== 'object') return null;
  const extra = value as Record<string, unknown>;

  const userId = text(extra.user_id);
  const roomId = text(extra.room_id);
  if (userId === null || roomId === null) return null;

  return { userId, roomId, eventId: text(extra.event_id) };
}

export function readAction(value: unknown): NativeNotificationAction | null {
  if (value === null || typeof value !== 'object') return null;
  const event = value as { actionId?: unknown; inputValue?: unknown; notification?: unknown };

  const actionId = text(event.actionId);
  if (actionId === null) return null;

  const notification = event.notification as { extra?: unknown } | undefined;
  const target = readTarget(notification?.extra);
  if (target === null) return null;

  const typed = text(event.inputValue);
  return { ...target, actionId, text: typed === null ? null : text(typed.trim()) };
}
