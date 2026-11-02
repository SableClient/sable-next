import type {
  NotificationModeView,
  RoomListItemView,
  SpaceNotificationsView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDataSync } from '#lib/core/account-data-sync.js';

import { i18n } from '#lib/i18n.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import { notificationModeLabels } from './notification-modes.js';
import { inheritedNotificationModes } from './spaces.js';

export const SPACE_NOTIFICATIONS_EVENT = 'moe.sable.space_notifications';

type Modes = ReadonlyMap<string, NotificationModeView>;

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
  exempt = $state.raw<ReadonlySet<string>>(new Set());
  loaded = $state(false);

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
    this.exempt = new Set();
    this.loaded = false;
  }

  #adopt(view: SpaceNotificationsView): void {
    this.modes = new Map(view.spaces.map((space) => [space.space_id, space.mode]));
    this.exempt = new Set(view.exempt_rooms);
  }

  modeOf(spaceId: string): NotificationModeView | null {
    return this.modes.get(spaceId) ?? null;
  }

  inherited(rooms: readonly RoomListItemView[]): Map<string, NotificationModeView> {
    return inheritedNotificationModes(rooms, this.modes, this.exempt);
  }

  /** The mode each room's space sets, whether or not the room follows it. */
  spaceModes(rooms: readonly RoomListItemView[]): Map<string, NotificationModeView> {
    return inheritedNotificationModes(rooms, this.modes);
  }

  async setExempt(room: RoomListItemView, exempt: boolean): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    const generation = this.sync.generation;
    const previous = this.exempt;
    const next: ReadonlySet<string> = new Set([
      ...[...previous].filter((id) => id !== room.room_id),
      ...(exempt ? [room.room_id] : []),
    ]);
    this.exempt = next;
    try {
      const stored = await core.rpc.account.setSpaceNotificationExempt({
        room_id: room.room_id,
        exempt,
      });
      if (generation === this.sync.generation) this.#adopt(stored);
    } catch (error) {
      if (this.exempt === next) this.exempt = previous;
      throw error;
    }
    this.#tried.delete(room.room_id);
    await core.rpc.notifications.setRoomNotificationMode({ room_id: room.room_id, mode: null });
  }

  custom(
    rooms: readonly RoomListItemView[]
  ): { room: RoomListItemView; mode: NotificationModeView }[] {
    const inherited = this.inherited(rooms);
    return rooms.flatMap((room) => {
      if (room.state !== 'joined') return [];
      const own = this.modes.get(room.room_id);
      if (own !== undefined) return [{ room, mode: own }];
      const rule = room.notification.room;
      if (rule === null || inherited.get(room.room_id) === rule) return [];
      return [{ room, mode: rule }];
    });
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
  ): Promise<number> {
    const core = this.sync.core;
    if (core === null) return 0;
    const generation = this.sync.generation;
    const previous = this.modes;
    const next: Modes = new Map([
      ...[...previous].filter(([id]) => id !== spaceId),
      ...(mode === null ? [] : [[spaceId, mode] as const]),
    ]);

    const before = inheritedNotificationModes(rooms, previous, this.exempt);
    const after = inheritedNotificationModes(rooms, next, this.exempt);
    const moved: [string, NotificationModeView | null][] = [];
    let changed = 0;
    for (const room of rooms) {
      if (room.room_id === spaceId) {
        if (room.notification.room !== mode) moved.push([spaceId, mode]);
        continue;
      }
      const was = before.get(room.room_id);
      const now = after.get(room.room_id);
      const rule = room.notification.room;
      if (was === now || (rule !== null && rule !== was)) continue;
      if (room.room_kind !== 'space') changed += 1;
      if (rule !== null) moved.push([room.room_id, now ?? null]);
    }

    this.modes = next;
    try {
      const stored = await core.rpc.account.setSpaceNotification({ space_id: spaceId, mode });
      if (generation === this.sync.generation) this.#adopt(stored);
    } catch (error) {
      if (this.modes === next) this.modes = previous;
      throw error;
    }
    await Promise.all(
      byMode(moved).map(([target, roomIds]) =>
        core.rpc.notifications.setRoomsNotificationMode({ room_ids: roomIds, mode: target })
      )
    );
    return changed;
  }

  private async pull(generation: number): Promise<void> {
    try {
      const core = this.sync.core;
      if (core === null) return;
      const view = await core.rpc.account.spaceNotifications();
      if (generation === this.sync.generation) this.#adopt(view);
    } catch (error) {
      console.debug('[sable rooms] space notification modes unavailable', error);
    } finally {
      if (generation === this.sync.generation) this.loaded = true;
    }
  }
}

export const spaceNotifications = new SpaceNotifications();

export async function setNotificationMode(
  core: CoreClient,
  roomList: { readonly rooms: readonly RoomListItemView[] },
  room: RoomListItemView,
  mode: NotificationModeView | null
): Promise<void> {
  if (room.room_kind !== 'space') {
    await core.rpc.notifications.setRoomNotificationMode({ room_id: room.room_id, mode });
    return;
  }
  const previous = spaceNotifications.modeOf(room.room_id);
  const count = await spaceNotifications.set(room.room_id, mode, roomList.rooms);
  toasts.undoable(
    i18n.t('room.spaceModeApplied', {
      count,
      space: room.display_name,
      mode: i18n.t(mode === null ? 'room.spaceModeDefault' : notificationModeLabels[mode]),
    }),
    {
      label: i18n.t('common.undo'),
      onUndo: () => {
        spaceNotifications.set(room.room_id, previous, roomList.rooms).catch((error: unknown) => {
          console.warn('[sable rooms] undoing the space notification mode failed', error);
          toasts.error(i18n.t('errors.actionFailed'));
        });
      },
    }
  );
}
