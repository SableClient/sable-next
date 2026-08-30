import type { NotificationView } from '#src/generated/NotificationView';
import type { RoomSummary } from '#src/generated/RoomSummary';

import { createContext } from 'svelte';

import { page } from '$app/state';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { loadMediaUrl } from '#lib/ui/media-url.js';

import { appendLine, type ConversationLine, summarise } from './conversation';
import { enabled, line, tag, title } from './present';
import { retireRoomAlerts } from './retire';

export const settingsChanges = $state({ version: 0 });

export const [useNotificationCenter, provideNotificationCenter] =
  createContext<NotificationCenter>();

const AVATAR_SIZE = 96;
type OpenRoom = (roomId: string, eventId: string | null) => void;

export class NotificationCenter {
  private stopEvents: (() => void) | null = null;
  private client: CoreClient | null = null;
  private open: OpenRoom | null = null;
  /* eslint-disable svelte/prefer-svelte-reactivity -- a write from a notification would subscribe whichever effect is running */
  private readonly unread = new Set<string>();
  private readonly conversations = new Map<string, ConversationLine[]>();
  private readonly presented = new Map<string, Notification>();
  /* eslint-enable svelte/prefer-svelte-reactivity */

  start(core: CoreClient, open: OpenRoom): void {
    this.stopEvents?.();
    this.client = core;
    this.open = open;
    this.stopEvents = core.subscribeEvents((event) => {
      if (event.type === 'notification_settings_changed') {
        settingsChanges.version += 1;
        return;
      }
      if (event.type === 'notification') this.present(event.notification);
    });
  }

  stop(): void {
    this.stopEvents?.();
    this.stopEvents = null;
    this.client = null;
    this.open = null;
    this.unread.clear();
    this.conversations.clear();
    this.presented.clear();
  }

  retireRead(rooms: readonly RoomSummary[]): void {
    if (!preferences.clearNotificationsOnRead) return;
    const userId = this.client?.session?.account_id;

    for (const room of rooms) {
      if (room.unread > 0) {
        this.unread.add(room.room_id);
        continue;
      }
      if (!this.unread.delete(room.room_id)) continue;

      this.conversations.delete(room.room_id);
      this.presented.get(room.room_id)?.close();
      this.presented.delete(room.room_id);
      if (userId !== undefined) {
        void retireRoomAlerts(userId, room.room_id).catch(() => undefined);
      }
    }
  }

  present(view: NotificationView): void {
    this.unread.add(view.room_id);

    const lines = appendLine(this.conversations.get(view.room_id) ?? [], line(view));
    this.conversations.set(view.room_id, lines);

    if (!enabled() || reading(view)) return;

    void this.show(view, lines);

    if (view.noisy !== false && preferences.notificationSounds) chime();
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
      open(view.room_id, view.event_id);
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

function reading(view: NotificationView): boolean {
  if (document.visibilityState !== 'visible') return false;
  const open = page.params.roomId;
  return open !== undefined && decodeURIComponent(open) === view.room_id;
}

function chime(): void {
  try {
    play();
  } catch (error) {
    console.debug('[sable notifications] no chime', error);
  }
}

function play(): void {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.06, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
  gain.connect(context.destination);

  const tone = context.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(880, context.currentTime);
  tone.frequency.setValueAtTime(1174, context.currentTime + 0.12);
  tone.connect(gain);
  tone.start();
  tone.stop(context.currentTime + 0.36);
  tone.onended = () => void context.close();
}
