import type { CoreEvent, NotificationView, RoomListItemView } from '#src/generated/protocol';

import { createContext } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { recordDebugLog } from '#lib/observability/debug-log.svelte.js';
import { electronBridge } from '#lib/platform/electron.js';
import { watchNativePushMessages } from '#lib/platform/native-notifications.js';
import { hasUnread, roomNotifications, type RoomUnread } from '#lib/rooms/unread.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { loadMediaUrl } from '#lib/ui/media-url.js';

import { parsePushPayload, webPushValidation } from '#lib/notifications/push-payload.js';
import { body, enabled, title } from './present';
import { retireReadAlerts, retireRoomAlerts } from './retire';
import { playNotificationSound } from './sound';
import { roomTag } from './tag';

export const settingsChanges = $state({ version: 0 });

export const [useNotificationCenter, provideNotificationCenter] =
  createContext<NotificationCenter>();

const AVATAR_SIZE = 96;
const POSTED_RETIRE_DELAY_MS = 1000;
type OpenRoom = (roomId: string, eventId: string | null) => void;

export class NotificationCenter {
  private stopEvents: (() => void) | null = null;
  private stopNativePush: (() => void) | null = null;
  private nativePushGeneration = 0;
  private client: CoreClient | null = null;
  private open: OpenRoom | null = null;
  private reading: string | null = null;
  private retirePosted: ReturnType<typeof setTimeout> | undefined;
  private rooms: readonly RoomListItemView[] = [];
  private unreadFor: RoomUnread = roomNotifications;
  /* eslint-disable svelte/prefer-svelte-reactivity -- a write from a notification would subscribe whichever effect is running */
  private readonly pushed = new Map<string, string>();
  private readonly unread = new Set<string>();
  private readonly retired = new Set<string>();
  private readonly readRooms = new Set<string>();
  private readonly invites = new Map<string, boolean>();
  private readonly presented = new Map<string, Notification[]>();
  private readonly callAlerts = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; shown: Promise<() => void> }
  >();
  /* eslint-enable svelte/prefer-svelte-reactivity */

  start(core: CoreClient, open: OpenRoom): void {
    for (const id of this.callAlerts.keys()) this.closeCall(id);
    void closeExpiredCalls().catch(failed('closing expired calls'));
    this.stopEvents?.();
    this.stopNativePush?.();
    this.client = core;
    this.open = open;
    this.stopEvents = core.subscribeEvents((event) => {
      if (event.type === 'notification_settings_changed') {
        settingsChanges.version += 1;
        return;
      }
      if (event.type === 'notification') this.present(event.notification);
      if (event.type === 'incoming_call') this.showCall(event);
      if (event.type === 'incoming_call_ended') this.closeCall(event.notification_event_id);
    });
    const generation = ++this.nativePushGeneration;
    void watchNativePushMessages((message) => {
      const validation = webPushValidation(message.message);
      if (validation !== null) {
        if (message.nativeActivation) return;
        void core.rpc.push
          .ackWebPusher({ app_id: validation.app_id, ack_token: validation.ack_token })
          .catch(failed('acknowledging web pusher'));
        return;
      }
      this.retirePush(message.message);
    })
      .then((stop) => {
        if (generation === this.nativePushGeneration) this.stopNativePush = stop;
        else stop();
      })
      .catch(failed('watching native push'));
  }

  stop(): void {
    for (const id of this.callAlerts.keys()) this.closeCall(id);
    this.stopEvents?.();
    this.stopEvents = null;
    this.stopNativePush?.();
    this.stopNativePush = null;
    this.nativePushGeneration += 1;
    clearTimeout(this.retirePosted);
    this.retirePosted = undefined;
    this.readRooms.clear();
    this.rooms = [];
    this.pushed.clear();
    this.client = null;
    this.open = null;
    this.reading = null;
    this.unread.clear();
    this.retired.clear();
    this.invites.clear();
    this.presented.clear();
  }

  private showCall(event: Extract<CoreEvent, { type: 'incoming_call' }>): void {
    const remaining = event.expires_at_ms - Date.now();
    if (!enabled() || remaining <= 0 || this.callAlerts.has(event.notification_event_id)) return;
    const open = this.open;
    const userId = this.client?.session?.user_id;
    const tag = `${roomTag(userId, event.room_id)}:${event.notification_event_id}`;
    const options: NotificationOptions = {
      body: event.ring ? 'Incoming call' : 'Call started',
      tag,
      silent: true,
      data: {
        roomId: event.room_id,
        userId,
        eventId: null,
        call: true,
        callEventId: event.notification_event_id,
        callExpiresAtMs: event.expires_at_ms,
      },
    };
    const name = preferences.notificationContent
      ? (event.sender_name ?? event.room_name ?? event.sender)
      : 'Sable';
    const shown = callBanner(name, options, () => {
      const electron = electronBridge();
      if (electron) electron.showWindow();
      else globalThis.focus();
      open?.(event.room_id, null);
      this.closeCall(event.notification_event_id);
    }).catch((error: unknown) => {
      failed('showing incoming call')(error);
      return () => {};
    });
    const timer = setTimeout(() => {
      this.closeCall(event.notification_event_id);
    }, remaining);
    this.callAlerts.set(event.notification_event_id, { timer, shown });
  }

  private closeCall(id: string): void {
    const userId = this.client?.session?.user_id;
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker
        .getRegistration()
        .then(async (registration) => {
          for (const notification of (await registration?.getNotifications()) ?? []) {
            const data = notification.data as
              | { call?: boolean; callEventId?: string; eventId?: string; userId?: string }
              | undefined;
            if (data?.call && (data.callEventId ?? data.eventId) === id && data.userId === userId)
              notification.close();
          }
        })
        .catch(failed('closing incoming call'));
    }
    const alert = this.callAlerts.get(id);
    if (!alert) return;
    this.callAlerts.delete(id);
    clearTimeout(alert.timer);
    void alert.shown.then((close) => {
      close();
    });
  }

  readRoom(roomId: string | null): void {
    if (this.reading === roomId) return;
    this.reading = roomId;

    void this.client?.rpc.session
      .setReadRoom({ room_id: roomId })
      .catch(failed('setting read room'));
    if (roomId !== null) this.settle(roomId);
  }

  retireRead(rooms: readonly RoomListItemView[], unreadFor: RoomUnread = roomNotifications): void {
    this.rooms = rooms;
    this.unreadFor = unreadFor;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- collected for one batched retire, never rendered
    const settled = new Set<string>();
    for (const [roomId, appeared] of this.invites) {
      const room = rooms.find((item) => item.room_id === roomId);
      if (room?.state === 'invited') {
        this.invites.set(roomId, true);
      } else if (room !== undefined || appeared) {
        settled.add(roomId);
      }
    }

    const read: string[] = [];
    for (const room of rooms) {
      if (room.state === 'invited') continue;
      if (hasUnread(unreadFor(room))) {
        this.unread.add(room.room_id);
        this.retired.delete(room.room_id);
        this.pushed.delete(room.room_id);
        continue;
      }

      read.push(room.room_id);
      this.unread.delete(room.room_id);
      if (this.readThrough(room, this.pushed.get(room.room_id))) {
        this.pushed.delete(room.room_id);
        settled.add(room.room_id);
        continue;
      }
      if (this.retired.has(room.room_id)) continue;
      settled.add(room.room_id);
    }

    this.settleAll([...settled]);
    if (preferences.clearNotificationsOnRead) this.retirePostedAlerts(read);
  }

  private retirePostedAlerts(roomIds: readonly string[]): void {
    for (const roomId of roomIds) this.readRooms.add(roomId);
    this.retirePosted ??= setTimeout(() => {
      this.retirePosted = undefined;
      const readRooms = [...this.readRooms];
      this.readRooms.clear();
      const userId = this.client?.session?.user_id;
      if (userId === undefined) return;
      void retireReadAlerts(userId, readRooms).catch(failed('retiring read alerts'));
    }, POSTED_RETIRE_DELAY_MS);
  }

  private settle(roomId: string): void {
    this.settleAll([roomId]);
  }

  private settleAll(roomIds: readonly string[]): void {
    if (preferences.clearNotificationsOnRead) this.retireAll(roomIds);
    else for (const roomId of roomIds) this.forget(roomId);
  }

  private forget(roomId: string): void {
    this.unread.delete(roomId);
    this.retired.add(roomId);
    this.invites.delete(roomId);
  }

  private retire(roomId: string): void {
    this.retireAll([roomId]);
  }

  private retireAll(roomIds: readonly string[]): void {
    if (roomIds.length === 0) return;
    for (const roomId of roomIds) {
      this.forget(roomId);
      const shown = this.presented.get(roomId);
      if (shown === undefined) continue;
      for (const notification of [...shown]) notification.close();
      this.presented.delete(roomId);
    }

    const userId = this.client?.session?.user_id;
    if (userId === undefined) return;
    void retireRoomAlerts(userId, roomIds).catch(failed('retiring room alerts'));
  }

  present(view: NotificationView): void {
    this.retired.delete(view.room_id);
    if (view.event_id === null) {
      this.invites.set(view.room_id, this.invites.get(view.room_id) ?? false);
    } else {
      this.unread.add(view.room_id);
    }

    const allowed = soundsAllowed();
    const chime = view.noisy !== false && preferences.notificationSounds && allowed;
    recordDebugLog('debug', 'notification', 'sound', chime ? 'chime' : 'silent', {
      noisy: view.noisy,
      sounds: preferences.notificationSounds,
      allowed,
      mention: view.mention,
      direct: view.is_direct,
      encrypted: view.encrypted,
    });
    if (chime) {
      void playNotificationSound('notification').catch((error: unknown) => {
        console.warn('[sable notification sound] failed', error);
      });
    }

    if (!enabled() || this.reading === view.room_id) return;

    void this.show(view);
  }

  private retirePush(raw: string): void {
    const notification = parsePushPayload(raw);
    if (!notification || notification.room_id === null) return;
    const roomId = notification.room_id;
    const userId = notification.user_id;
    if (userId !== null && userId !== this.client?.session?.user_id) {
      if (notification.unread === 0) {
        void retireRoomAlerts(userId, [roomId]).catch(failed('retiring room alerts'));
      }
      return;
    }
    if (notification.unread === 0 || this.reading === roomId) {
      this.retire(roomId);
      return;
    }
    if (notification.event_id === null) return;

    const room = this.rooms.find((item) => item.room_id === roomId);
    if (room !== undefined && this.readThrough(room, notification.event_id)) this.settle(roomId);
    else this.pushed.set(roomId, notification.event_id);
  }

  private readThrough(room: RoomListItemView, eventId: string | undefined): boolean {
    return (
      eventId !== undefined &&
      room.latest_event?.event_id === eventId &&
      !hasUnread(this.unreadFor(room))
    );
  }

  private async show(view: NotificationView): Promise<void> {
    const core = this.client;
    const open = this.open;
    if (core === null || open === null) return;

    const options = {
      body: body(view),
      icon: await avatar(core, view),
      silent: true,
    };
    let notification: Notification;
    try {
      notification = new Notification(title(view), options);
    } catch {
      await showFromWorker(title(view), {
        ...options,
        data: { roomId: view.room_id, userId: view.user_id, eventId: view.event_id },
      });
      return;
    }
    electronBridge()?.requestAttention();

    notification.addEventListener('click', () => {
      const electron = electronBridge();
      if (electron) electron.showWindow();
      else globalThis.focus();
      notification.close();
      open(view.room_id, view.event_id);
    });
    const shown = this.presented.get(view.room_id) ?? [];
    shown.push(notification);
    notification.addEventListener('close', () => {
      const index = shown.indexOf(notification);
      if (index !== -1) shown.splice(index, 1);
      if (shown.length === 0 && this.presented.get(view.room_id) === shown) {
        this.presented.delete(view.room_id);
      }
    });
    this.presented.set(view.room_id, shown);
  }
}

async function avatar(core: CoreClient, view: NotificationView): Promise<string> {
  const source = view.room_avatar_url ?? view.sender_avatar_url;
  if (source === null) return FALLBACK_ICON;

  return loadMediaUrl(core, source, AVATAR_SIZE, AVATAR_SIZE).catch((error: unknown) => {
    failed('loading notification avatar')(error);
    return FALLBACK_ICON;
  });
}

async function callBanner(
  title: string,
  options: NotificationOptions,
  open: () => void
): Promise<() => void> {
  try {
    const notification = new Notification(title, options);
    notification.addEventListener('click', open);
    return () => {
      notification.close();
    };
  } catch {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.showNotification(title, options);
    return () => {
      void registration
        ?.getNotifications({ tag: options.tag })
        .then((notifications) => {
          for (const notification of notifications) notification.close();
        })
        .catch(failed('closing incoming call'));
    };
  }
}

async function closeExpiredCalls(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration || !('getNotifications' in registration)) return;
  for (const notification of await registration.getNotifications()) {
    const data = notification.data as { call?: boolean; callExpiresAtMs?: number } | undefined;
    if (data?.call && (data.callExpiresAtMs ?? 0) <= Date.now()) notification.close();
  }
}

async function showFromWorker(title: string, options: NotificationOptions): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  await registration?.showNotification(title, options);
}

const FALLBACK_ICON = '/favicon.png';

function failed(what: string): (error: unknown) => void {
  return (error) => {
    console.debug(`[sable notifications] ${what} failed`, error);
  };
}

function soundsAllowed(): boolean {
  if (preferences.backgroundNotificationSounds) return true;
  return typeof document !== 'undefined' && document.hasFocus();
}
