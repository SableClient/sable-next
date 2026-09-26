import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core';

import { deliversNativePush } from './notifications.js';

export interface NativeNotificationTarget {
  userId: string;
  roomId: string;
  eventId: string | null;
}

export interface NativeNotificationAction extends NativeNotificationTarget {
  actionId: string;
  text: string | null;
}

export interface NativePushMessage {
  message: string;
  nativeActivation?: boolean;
}

export function alertsNatively(): boolean {
  return isTauri();
}

export type NotificationGrant = 'granted' | 'denied' | 'prompt';

export async function nativeNotificationPermission(): Promise<NotificationGrant> {
  if (!isTauri()) return 'granted';
  return invoke<NotificationGrant>('notification_permission');
}

export async function requestNativeNotificationPermission(): Promise<NotificationGrant> {
  if (!isTauri()) return 'granted';
  return invoke<NotificationGrant>('request_notification_permission');
}

export async function dismissNativeRoomNotification(userId: string, roomId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('dismiss_room_notification', { userId, roomId });
}

export async function dismissNativeReadRoomNotifications(
  userId: string,
  roomIds: readonly string[]
): Promise<void> {
  if (!(await deliversNativePush())) return;
  await invoke('dismiss_read_room_notifications', { userId, roomIds });
}

export async function setNativeEncryptedContentAllowed(
  allowed: boolean,
  content = false,
  enabled = true,
  sounds = true,
  notifyOnce = true
): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_notification_encrypted_content', {
    allowed,
    content,
    enabled,
    sounds,
    notifyOnce,
  });
}

export async function sendNativeTestNotification(sequence: number): Promise<void> {
  await invoke('test_notification', { sequence });
}

export interface NativePushDiagnostics {
  counts: Record<string, number>;
  lastOutcome: string | null;
  lastAt: number;
}

/** The cold path posts from a process the app never sees, so its outcome is
    only readable here. */
export async function takeNativePushDiagnostics(): Promise<NativePushDiagnostics | null> {
  if (!isTauri()) return null;
  try {
    const taken = await invoke<{
      counts?: Record<string, number>;
      lastOutcome?: string;
      lastAt?: number;
    }>('plugin:notifications|take_push_diagnostics');
    return {
      counts: taken.counts ?? {},
      lastOutcome: taken.lastOutcome ?? null,
      lastAt: taken.lastAt ?? 0,
    };
  } catch {
    return null;
  }
}

export async function nativePushHistory(): Promise<unknown[] | null> {
  if (!isTauri()) return null;
  try {
    const taken = await invoke<{ entries?: unknown[] }>('plugin:notifications|push_history');
    return taken.entries ?? [];
  } catch {
    return null;
  }
}

export async function clearNativePushHistory(): Promise<void> {
  if (!isTauri()) return;
  await invoke('plugin:notifications|clear_push_history');
}

export interface NativePushTransport {
  provider: string | null;
  distributor: string | null;
}

export interface NativeDevicePusher {
  pushkey: string;
  appId: string;
}

export async function nativeDevicePusher(
  userId: string,
  deviceId: string
): Promise<NativeDevicePusher | null> {
  if (!isTauri()) return null;
  try {
    const pusher = await invoke<{ pushkey: string; app_id: string } | null>('device_pusher', {
      userId,
      deviceId,
    });
    return pusher === null ? null : { pushkey: pusher.pushkey, appId: pusher.app_id };
  } catch {
    return null;
  }
}

export async function nativePushTransport(): Promise<NativePushTransport | null> {
  if (!isTauri()) return null;
  try {
    const transport = await invoke<{ provider?: string; distributor?: string }>(
      'plugin:notifications|push_transport'
    );
    return { provider: transport.provider ?? null, distributor: transport.distributor ?? null };
  } catch {
    return null;
  }
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

export async function watchNativePushMessages(
  handler: (message: NativePushMessage) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};

  const listener = await addPluginListener('notifications', 'push-message', (event: unknown) => {
    const message = readPushMessage(event);
    if (message !== null)
      handler({
        message,
        ...(event !== null &&
        typeof event === 'object' &&
        'nativeActivation' in event &&
        event.nativeActivation === true
          ? { nativeActivation: true }
          : {}),
      });
  });
  await invoke('plugin:notifications|set_push_message_listener_active', { active: true });

  return () => {
    void invoke('plugin:notifications|set_push_message_listener_active', { active: false }).catch(
      () => undefined
    );
    void listener.unregister().catch(() => undefined);
  };
}

export async function watchNativePushTokens(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const listener = await addPluginListener('notifications', 'push-token', (event: unknown) => {
    if (event !== null && typeof event === 'object' && 'rotated' in event && event.rotated === true)
      handler();
  });
  return () => {
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

export function readPushMessage(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const event = value as { message?: unknown; data?: unknown };
  if (typeof event.message === 'string') return event.message;
  if (event.data === null || typeof event.data !== 'object') return null;
  return JSON.stringify(event.data);
}
