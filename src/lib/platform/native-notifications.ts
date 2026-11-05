import { addPluginListener, invoke, isTauri, type PluginListener } from '@tauri-apps/api/core';

import { deliversNativePush } from './notifications.js';
import { isAndroid } from './os.js';

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

export async function dismissNativeRoomNotifications(
  userId: string,
  roomIds: readonly string[]
): Promise<void> {
  if (!isTauri()) return;
  await invoke('dismiss_room_notifications', { userId, roomIds });
}

let openConversation: Promise<void> = Promise.resolve();

/** In call order, so leaving one room never lands after opening the next. */
export function setNativeOpenConversation(
  userId: string | null,
  roomId: string | null
): Promise<void> {
  if (!isAndroid()) return Promise.resolve();
  const next = openConversation.then(() =>
    invoke('set_open_conversation', { userId, roomId }).then(() => undefined)
  );
  openConversation = next.catch(() => undefined);
  return next;
}

export async function forgetLeftNativeConversations(): Promise<void> {
  if (!isAndroid()) return;
  await invoke('forget_left_conversations');
}

export async function dismissNativeReadRoomNotifications(
  userId: string,
  roomIds: readonly string[]
): Promise<void> {
  if (!deliversNativePush()) return;
  await invoke('dismiss_read_room_notifications', { userId, roomIds });
}

export interface NativeNotificationPolicy {
  enabled: boolean;
  content: boolean;
  encryptedContent: boolean;
  sounds: boolean;
  notifyOnce: boolean;
  clearOnRead: boolean;
  privateReceipts: boolean;
  quietWhenActiveElsewhere: boolean;
}

export async function setNativeNotificationPolicy(policy: NativeNotificationPolicy): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_notification_policy', { policy });
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
    }>('plugin:sable-push|take_push_diagnostics');
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
    const taken = await invoke<{ entries?: unknown[] }>('plugin:sable-push|push_history');
    return taken.entries ?? [];
  } catch {
    return null;
  }
}

export async function clearNativePushHistory(): Promise<void> {
  if (!isTauri()) return;
  await invoke('plugin:sable-push|clear_push_history');
}

export async function playNativeChime(volume: number): Promise<void> {
  await invoke('plugin:sable-push|play_chime', { volume });
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

async function androidFlag(command: string): Promise<boolean | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<boolean>(`plugin:notifications|${command}`);
  } catch {
    return null;
  }
}

export const ignoringBatteryOptimizations = () => androidFlag('is_ignoring_battery_optimizations');

export const canScheduleExactAlarms = () => androidFlag('can_schedule_exact_alarms');

export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  await invoke('plugin:notifications|request_ignore_battery_optimizations');
}

export async function requestScheduleExactAlarms(): Promise<void> {
  await invoke('plugin:notifications|request_schedule_exact_alarms');
}

type NativeEventHandler = (event: unknown) => void;
type NativeListener = {
  handlers: Set<NativeEventHandler>;
  listener: PluginListener | null;
  pending: Promise<void>;
};

const nativeListeners = new Map<string, NativeListener>();

function queueListener(state: NativeListener, operation: () => Promise<void>): Promise<void> {
  const pending = state.pending.then(operation);
  state.pending = pending.catch(() => {});
  return pending;
}

async function watchNativeEvent(
  event: string,
  command: string,
  handler: NativeEventHandler,
  signal?: AbortSignal
): Promise<() => void> {
  if (!isTauri() || signal?.aborted) return () => {};
  const state: NativeListener = nativeListeners.get(event) ?? {
    handlers: new Set(),
    listener: null,
    pending: Promise.resolve(),
  };
  nativeListeners.set(event, state);
  state.handlers.add(handler);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', stop);
    state.handlers.delete(handler);
    void queueListener(state, async () => {
      if (state.handlers.size !== 0 || state.listener === null) return;
      const listener = state.listener;
      state.listener = null;
      try {
        await invoke(command, { active: false });
      } finally {
        await listener.unregister();
      }
    }).catch(listenerNotReleased);
  };
  signal?.addEventListener('abort', stop, { once: true });

  try {
    await queueListener(state, async () => {
      if (state.listener !== null || state.handlers.size === 0) return;
      const listener = await addPluginListener('notifications', event, (value: unknown) => {
        for (const receive of state.handlers) receive(value);
      });
      if (state.handlers.size === 0) {
        await listener.unregister();
        return;
      }
      try {
        await invoke(command, { active: true });
        state.listener = listener;
      } catch (error) {
        await invoke(command, { active: false }).catch(listenerNotReleased);
        await listener.unregister().catch(listenerNotReleased);
        throw error;
      }
    });
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

export function watchNativeNotificationActions(
  handler: (action: NativeNotificationAction) => void,
  signal?: AbortSignal
): Promise<() => void> {
  return watchNativeEvent(
    'actionPerformed',
    'plugin:notifications|set_action_listener_active',
    (event) => {
      const action = readAction(event);
      if (action !== null) handler(action);
    },
    signal
  );
}

export function watchNativeNotificationClicks(
  handler: (target: NativeNotificationTarget) => void,
  signal?: AbortSignal
): Promise<() => void> {
  return watchNativeEvent(
    'notificationClicked',
    'plugin:notifications|set_click_listener_active',
    (event: unknown) => {
      const target = readTarget((event as { data?: unknown } | undefined)?.data);
      if (target !== null) handler(target);
    },
    signal
  );
}

export function watchNativePushMessages(
  handler: (message: NativePushMessage) => void,
  signal?: AbortSignal
): Promise<() => void> {
  return watchNativeEvent(
    'push-message',
    'plugin:notifications|set_push_message_listener_active',
    (event) => {
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
    },
    signal
  );
}

export async function watchNativePushTokens(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const listener = await addPluginListener('notifications', 'push-token', (event: unknown) => {
    if (event !== null && typeof event === 'object' && 'rotated' in event && event.rotated === true)
      handler();
  });
  return () => {
    void listener.unregister().catch(listenerNotReleased);
  };
}

function listenerNotReleased(error: unknown): void {
  console.debug('[sable notifications] native listener not released', error);
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
