import type {
  NotificationModeView,
  RoomListItemView,
  SpaceNotificationView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDataSync } from '#lib/core/account-data-sync.js';

import { inheritedNotificationModes } from './spaces.js';

export const SPACE_NOTIFICATIONS_EVENT = 'moe.sable.space_notifications';

type Modes = ReadonlyMap<string, NotificationModeView>;

function toModes(views: readonly SpaceNotificationView[]): Modes {
  return new Map(views.map((view) => [view.space_id, view.mode]));
}

function byMode(
  entries: readonly [string, NotificationModeView | null][]
): [NotificationModeView | null, string[]][] {
  const modes = [...new Set(entries.map(([, mode]) => mode))];
  return modes.map((mode) => [
    mode,
    entries.filter((entry) => entry[1] === mode).map(([roomId]) => roomId),
  ]);
}

class SpaceNotifications {
  modes = $state.raw<Modes>(new Map());

  /** Not cleared on failure, so a rejected write is not retried on every list change. */
  readonly #tried = new Set<string>();

  private readonly sync = new AccountDataSync([SPACE_NOTIFICATIONS_EVENT], (generation) =>
    this.pull(generation)
  );

  start(core: CoreClient): void {
    this.#tried.clear();
    this.sync.start(core);
  }

  stop(): void {
    this.sync.stop();
    this.modes = new Map();
  }

  modeOf(spaceId: string): NotificationModeView | null {
    return this.modes.get(spaceId) ?? null;
  }

  inherited(rooms: readonly RoomListItemView[]): Map<string, NotificationModeView> {
    return inheritedNotificationModes(rooms, this.modes);
  }

  apply(rooms: readonly RoomListItemView[]): void {
    const core = this.sync.core;
    if (core === null) return;
    const byId = new Map(rooms.map((room) => [room.room_id, room]));
    const pending: [string, NotificationModeView][] = [];
    for (const [roomId, mode] of this.inherited(rooms)) {
      if (byId.get(roomId)?.notification.room !== null || this.#tried.has(roomId)) continue;
      this.#tried.add(roomId);
      pending.push([roomId, mode]);
    }
    for (const [mode, roomIds] of byMode(pending)) {
      core.rpc.notifications
        .setRoomsNotificationMode({ room_ids: roomIds, mode })
        .then(() => {
          for (const roomId of roomIds) this.#tried.delete(roomId);
        })
        .catch((error: unknown) => {
          console.warn('[sable rooms] space notification mode not applied', error);
        });
    }
  }

  async set(
    spaceId: string,
    mode: NotificationModeView | null,
    rooms: readonly RoomListItemView[]
  ): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    const generation = this.sync.generation;
    const previous = this.modes;
    const next: Modes = new Map([
      ...[...previous].filter(([id]) => id !== spaceId),
      ...(mode === null ? [] : [[spaceId, mode] as const]),
    ]);

    const before = inheritedNotificationModes(rooms, previous);
    const after = inheritedNotificationModes(rooms, next);
    const moved: [string, NotificationModeView | null][] = [];
    for (const room of rooms) {
      if (room.room_id === spaceId) {
        if (room.notification.room !== mode) moved.push([spaceId, mode]);
        continue;
      }
      const was = before.get(room.room_id);
      const now = after.get(room.room_id);
      if (was === undefined || was === now || room.notification.room !== was) continue;
      moved.push([room.room_id, now ?? null]);
    }

    this.modes = next;
    try {
      const stored = await core.rpc.account.setSpaceNotification({ space_id: spaceId, mode });
      if (generation === this.sync.generation) this.modes = toModes(stored);
    } catch (error) {
      if (this.modes === next) this.modes = previous;
      throw error;
    }
    await Promise.all(
      byMode(moved).map(([target, roomIds]) =>
        core.rpc.notifications.setRoomsNotificationMode({ room_ids: roomIds, mode: target })
      )
    );
  }

  private async pull(generation: number): Promise<void> {
    try {
      const core = this.sync.core;
      if (core === null) return;
      const views = await core.rpc.account.spaceNotifications();
      if (generation === this.sync.generation) this.modes = toModes(views);
    } catch (error) {
      console.debug('[sable rooms] space notification modes unavailable', error);
    }
  }
}

export const spaceNotifications = new SpaceNotifications();
