import type { NotificationView, PreviewEmote } from '#src/generated/protocol';

import { isTauri } from '@tauri-apps/api/core';

import { preferences } from '#lib/settings/preferences.svelte.js';
import { windowActivity } from '#lib/platform/window-activity.js';

import { body, bodySegments, title } from './present';

export type Banner = {
  roomId: string;
  userId: string;
  eventId: string;
  title: string;
  body: string;
  segments: (string | PreviewEmote)[];
  avatar: string | null;
  mention: boolean;
  count: number;
  /** Restarts the countdown when the room speaks again. */
  revision: number;
};

/** Must match `Core::shows_banner`, which skips the native alert for these. A desktop
    window that is visible but unfocused still gets a system alert. */
export function showsBanner(view: NotificationView): boolean {
  return (
    preferences.inAppBanners &&
    (isTauri() ? windowActivity.visible : windowActivity.active) &&
    view.event_id !== null &&
    (view.mention || view.is_direct)
  );
}

const ANNOUNCE_MS = 3000;

export class InAppBanners {
  items = $state.raw<Banner[]>([]);
  /** Not derived from `items`, so a dismissal is never read out as a new message. */
  announced = $state.raw<Banner | null>(null);
  #revision = 0;
  #silence: ReturnType<typeof setTimeout> | undefined;
  #held: string | null = null;

  hold(roomId: string): void {
    this.#held = roomId;
  }

  release(roomId: string): void {
    if (this.#held === roomId) this.#held = null;
  }

  show(view: NotificationView): void {
    if (view.event_id === null) return;
    const previous = this.items.find((item) => item.roomId === view.room_id);
    const banner: Banner = {
      roomId: view.room_id,
      userId: view.user_id,
      eventId: view.event_id,
      title: title(view),
      body: body(view),
      segments: bodySegments(view),
      avatar: view.room_avatar_url ?? view.sender_avatar_url,
      mention: view.mention || (previous?.mention ?? false),
      count: (previous?.count ?? 0) + 1,
      revision: ++this.#revision,
    };
    this.announced = banner;
    clearTimeout(this.#silence);
    this.#silence = setTimeout(() => {
      this.announced = null;
    }, ANNOUNCE_MS);
    if (this.#held !== null) {
      this.items = previous
        ? this.items.map((item) => (item === previous ? banner : item))
        : [...this.items, banner];
      return;
    }
    const rest = this.items.filter((item) => item !== previous);
    this.items = [banner, ...rest].sort((a, b) => Number(b.mention) - Number(a.mention));
  }

  dismiss(roomId: string): void {
    this.release(roomId);
    if (!this.items.some((item) => item.roomId === roomId)) return;
    this.items = this.items.filter((item) => item.roomId !== roomId);
  }

  dismissAll(): void {
    this.#held = null;
    this.items = [];
  }

  clear(): void {
    clearTimeout(this.#silence);
    this.#held = null;
    this.announced = null;
    this.items = [];
  }
}
