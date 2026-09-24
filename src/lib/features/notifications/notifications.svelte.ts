import type { NotificationView, RoomSummary } from '#src/generated/protocol';

import { createContext } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { watchNativePushMessages } from '#lib/platform/native-notifications.js';
import { hasUnread, roomNotifications, type RoomUnread } from '#lib/rooms/unread.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { loadMediaUrl } from '#lib/ui/media-url.js';

import { appendLine, type ConversationLine, summarise } from './conversation';
import { parsePushPayload, webPushValidation } from './push-payload';
import { enabled, line, tag, title } from './present';
import { retireReadAlerts, retireRoomAlerts } from './retire';
import { playNotificationSound } from './sound';

export const settingsChanges = $state({ version: 0 });

export const [useNotificationCenter, provideNotificationCenter] =
  createContext<NotificationCenter>();

const AVATAR_SIZE = 96;
const POSTED_RETIRE_DELAY_MS = 1000;
type OpenRoom = (roomId: string) => void;

export class NotificationCenter {
  private stopEvents: (() => void) | null = null;
  private stopNativePush: (() => void) | null = null;
  private nativePushGeneration = 0;
  private client: CoreClient | null = null;
  private open: OpenRoom | null = null;
  private reading: string | null = null;
  private retirePosted: ReturnType<typeof setTimeout> | undefined;
  private readRooms: readonly string[] = [];
  private rooms: readonly RoomSummary[] = [];
  private unreadFor: RoomUnread = roomNotifications;
  /* eslint-disable svelte/prefer-svelte-reactivity -- a write from a notification would subscribe whichever effect is running */
  private readonly pushed = new Map<string, string>();
  private readonly unread = new Set<string>();
  private readonly retired = new Set<string>();
  private readonly invites = new Map<string, boolean>();
  private readonly conversations = new Map<string, ConversationLine[]>();
  private readonly presented = new Map<string, Notification>();
  /* eslint-enable svelte/prefer-svelte-reactivity */

  start(core: CoreClient, open: OpenRoom): void {
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
    });
    const generation = ++this.nativePushGeneration;
    void watchNativePushMessages((message) => {
      const validation = webPushValidation(message.message);
      if (validation !== null) {
        if (message.nativeActivation) return;
        void core.commands
          .ackWebPusher(validation.appId, validation.ackToken)
          .catch(() => undefined);
        return;
      }
      this.retirePush(message.message);
    })
      .then((stop) => {
        if (generation === this.nativePushGeneration) this.stopNativePush = stop;
        else stop();
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.stopEvents?.();
    this.stopEvents = null;
    this.stopNativePush?.();
    this.stopNativePush = null;
    this.nativePushGeneration += 1;
    clearTimeout(this.retirePosted);
    this.retirePosted = undefined;
    this.readRooms = [];
    this.rooms = [];
    this.pushed.clear();
    this.client = null;
    this.open = null;
    this.reading = null;
    this.unread.clear();
    this.retired.clear();
    this.invites.clear();
    this.conversations.clear();
    this.presented.clear();
  }

  readRoom(roomId: string | null): void {
    if (this.reading === roomId) return;
    this.reading = roomId;

    void this.client?.commands.setReadRoom(roomId).catch(() => undefined);
    if (roomId !== null) this.settle(roomId);
  }

  retireRead(rooms: readonly RoomSummary[], unreadFor: RoomUnread = roomNotifications): void {
    this.rooms = rooms;
    this.unreadFor = unreadFor;
    for (const [roomId, appeared] of this.invites) {
      const room = rooms.find((item) => item.room_id === roomId);
      if (room?.state === 'invited') {
        this.invites.set(roomId, true);
      } else if (room !== undefined || appeared) {
        this.settle(roomId);
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
        this.settle(room.room_id);
        continue;
      }
      if (this.retired.has(room.room_id)) continue;
      this.settle(room.room_id);
    }

    if (preferences.clearNotificationsOnRead) this.retirePostedAlerts(read);
  }

  private retirePostedAlerts(roomIds: readonly string[]): void {
    this.readRooms = roomIds;
    this.retirePosted ??= setTimeout(() => {
      this.retirePosted = undefined;
      const userId = this.client?.session?.user_id;
      if (userId === undefined) return;
      void retireReadAlerts(userId, this.readRooms).catch(() => undefined);
    }, POSTED_RETIRE_DELAY_MS);
  }

  private settle(roomId: string): void {
    if (preferences.clearNotificationsOnRead) this.retire(roomId);
    else this.forget(roomId);
  }

  private forget(roomId: string): void {
    this.unread.delete(roomId);
    this.retired.add(roomId);
    this.invites.delete(roomId);
    this.conversations.delete(roomId);
  }

  private retire(roomId: string): void {
    this.forget(roomId);
    this.presented.get(roomId)?.close();
    this.presented.delete(roomId);

    const userId = this.client?.session?.user_id;
    if (userId === undefined) return;
    void retireRoomAlerts(userId, roomId).catch(() => undefined);
  }

  present(view: NotificationView): void {
    this.retired.delete(view.room_id);
    if (view.event_id === null) {
      this.invites.set(view.room_id, this.invites.get(view.room_id) ?? false);
    } else {
      this.unread.add(view.room_id);
    }

    const standing = this.conversations.get(view.room_id) ?? [];
    const lines = appendLine(standing, line(view));
    this.conversations.set(view.room_id, lines);

    const quiet = preferences.notifyOnce && standing.length > 0 && !view.mention;
    if (view.noisy !== false && preferences.notificationSounds && !quiet && soundsAllowed()) {
      void playNotificationSound().catch(() => undefined);
    }

    if (!enabled() || this.reading === view.room_id) return;

    void this.show(view, lines);
  }

  private retirePush(raw: string): void {
    const notification = parsePushPayload(raw)?.notification;
    if (notification?.room_id === undefined) return;
    const roomId = notification.room_id;
    if (notification.counts?.unread === 0 || this.reading === roomId) {
      this.retire(roomId);
      return;
    }
    if (notification.event_id === undefined) return;

    const room = this.rooms.find((item) => item.room_id === roomId);
    if (room !== undefined && this.readThrough(room, notification.event_id)) this.settle(roomId);
    else this.pushed.set(roomId, notification.event_id);
  }

  private readThrough(room: RoomSummary, eventId: string | undefined): boolean {
    return (
      eventId !== undefined &&
      room.latest_event?.event_id === eventId &&
      !hasUnread(this.unreadFor(room))
    );
  }

  private async show(view: NotificationView, lines: readonly ConversationLine[]): Promise<void> {
    const core = this.client;
    const open = this.open;
    if (core === null || open === null) return;

    const notification = new Notification(title(view), {
      body: summarise(lines),
      tag: tag(view),
      icon: await avatar(core, view),
      silent: true,
    });

    notification.addEventListener('click', () => {
      globalThis.focus();
      notification.close();
      open(view.room_id);
    });
    notification.addEventListener('close', () => {
      if (this.presented.get(view.room_id) === notification) this.presented.delete(view.room_id);
    });

    this.presented.set(view.room_id, notification);
  }
}

async function avatar(core: CoreClient, view: NotificationView): Promise<string> {
  const source = view.room_avatar_url ?? view.sender_avatar_url;
  if (source === null) return FALLBACK_ICON;

  return loadMediaUrl(core, source, AVATAR_SIZE, AVATAR_SIZE).catch(() => FALLBACK_ICON);
}

const FALLBACK_ICON = '/favicon.png';

function soundsAllowed(): boolean {
  if (preferences.backgroundNotificationSounds) return true;
  return typeof document !== 'undefined' && document.hasFocus();
}
