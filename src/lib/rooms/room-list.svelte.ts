import { createContext } from 'svelte';

import type { NotificationModeView, RoomListItemView, RoomsView } from '#src/generated/protocol';

import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
import { runtime } from '#lib/runtime/app.js';
import type { Client } from '#lib/runtime/client.js';
import { SliceHandle } from '#lib/runtime/handle.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { quietTargets } from './quiet-rooms.svelte.js';
import {
  NO_UNREAD,
  roomNotifications,
  type RoomUnread,
  roomUnread,
  type UnreadCount,
} from './unread.js';

const NO_ROOMS: RoomListItemView[] = [];
const NO_BADGES: RoomsView['badges'] = {};
const NO_IDS: string[] = [];

/** Only use an alias when it resolves locally to this room. */
const aliasOwners = new WeakMap<readonly RoomListItemView[], Map<string, string>>();

function aliasOwner(rooms: readonly RoomListItemView[], alias: string): string | undefined {
  let owners = aliasOwners.get(rooms);
  if (owners === undefined) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup index for one immutable rooms array
    owners = new Map();
    for (const room of rooms) {
      const owned = room.canonical_alias;
      if (!room.is_tombstoned && owned && !owners.has(owned)) owners.set(owned, room.room_id);
    }
    aliasOwners.set(rooms, owners);
  }
  return owners.get(alias);
}

export function roomPathId(room: RoomListItemView, rooms: readonly RoomListItemView[]): string {
  const alias = room.canonical_alias;
  if (!room.is_tombstoned && alias && aliasOwner(rooms, alias) === room.room_id) {
    return alias;
  }
  return room.room_id;
}

/** `resolve()` inserts route parameters verbatim, including `#`. */
export function roomPathParamFromId(roomId: string): string {
  return encodeURIComponent(roomId);
}

export function roomPathParam(room: RoomListItemView, rooms: readonly RoomListItemView[]): string {
  return roomPathParamFromId(roomPathId(room, rooms));
}

function directPeer(room: RoomListItemView): string | null {
  return room.is_direct && room.direct_targets.length === 1 ? room.direct_targets[0] : null;
}

export function roomLabel(room: RoomListItemView): string {
  const label = room.name ?? room.canonical_alias ?? room.room_id;
  const peer = directPeer(room);
  return peer === null ? label : profileOverrides.name(peer, label);
}

export function roomAvatarUrl(room: RoomListItemView): string | null {
  const peer = directPeer(room);
  return peer === null ? room.avatar_url : profileOverrides.avatar(peer, room.avatar_url);
}

export function hasDirectRoom(rooms: readonly RoomListItemView[], userId: string): boolean {
  return rooms.some(
    (room) => room.is_direct && !room.is_tombstoned && room.direct_targets.includes(userId)
  );
}

export function findRoomByPathId(
  rooms: readonly RoomListItemView[],
  pathId: string | undefined
): RoomListItemView | undefined {
  if (pathId === undefined) return undefined;
  return rooms.find(
    (room) => room.room_id === pathId || (!room.is_tombstoned && room.canonical_alias === pathId)
  );
}

const NOBODY_TYPING: readonly string[] = [];

const roomIndexes = new WeakMap<readonly RoomListItemView[], Map<string, RoomListItemView>>();

function roomIndex(rooms: readonly RoomListItemView[]): Map<string, RoomListItemView> {
  let index = roomIndexes.get(rooms);
  if (index === undefined) {
    index = new Map(rooms.map((room) => [room.room_id, room]));
    roomIndexes.set(rooms, index);
  }
  return index;
}

/** The rooms slice of the runtime, read the way the app reads it. */
export class RoomList {
  private readonly handle: SliceHandle<'rooms'>;
  private stopPreferences: (() => void) | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- resolved from the subscription, never rendered
  private readonly listedWaiters = new Set<{ roomId: string; resolve: () => void }>();

  constructor(connect: () => Promise<Client> = runtime) {
    this.handle = new SliceHandle('rooms', null, connect, {
      onChange: () => {
        this.resolveListed();
      },
      onOpen: () => {
        this.sendPreferences();
      },
    });
  }

  get rooms(): RoomListItemView[] {
    return this.handle.view?.items ?? NO_ROOMS;
  }

  get settled(): boolean {
    return this.handle.view?.settled ?? false;
  }

  get quietRoomIds(): ReadonlySet<string> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt from the status, never mutated
    return new Set(this.handle.view?.quiet_room_ids ?? NO_IDS);
  }

  /** What each joined space's badge shows, for the spaces that show anything. */
  get spaceUnread(): ReadonlyMap<string, UnreadCount> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt from the status, never mutated
    return new Map(Object.entries(this.handle.view?.space_unread ?? NO_BADGES));
  }

  byId(roomId: string | null | undefined): RoomListItemView | undefined {
    return roomId === null || roomId === undefined ? undefined : roomIndex(this.rooms).get(roomId);
  }

  whenListed(roomId: string, timeoutMs: number): Promise<void> {
    if (this.rooms.some((room) => room.room_id === roomId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { roomId, resolve: finish };
      const timer = setTimeout(finish, timeoutMs);
      this.listedWaiters.add(waiter);
      const waiters = this.listedWaiters;
      function finish(): void {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve();
      }
    });
  }

  labelFor(roomId: string): string {
    const room = this.byId(roomId);
    return room ? roomLabel(room) : roomId;
  }

  warm(roomId: string): void {
    this.handle.send({ type: 'warm', room_id: roomId });
  }

  typingUserIds(roomId: string): readonly string[] {
    return this.handle.view?.typing[roomId] ?? NOBODY_TYPING;
  }

  notificationOverride(roomId: string): NotificationModeView | null {
    return this.byId(roomId)?.notification.room ?? null;
  }

  notificationMode(roomId: string): NotificationModeView | null {
    const notification = this.byId(roomId)?.notification;
    return notification ? (notification.room ?? notification.default) : null;
  }

  readonly unreadFor: RoomUnread = roomUnread;

  readonly badgeUnreadFor: RoomUnread = (room) =>
    this.handle.view?.badges[room.room_id] ?? NO_UNREAD;

  readonly notificationsFor: RoomUnread = roomNotifications;

  /** Follows the room list, and sends the reader's preferences now and whenever they change. */
  async start(): Promise<void> {
    this.stopPreferences ??= $effect.root(() => {
      $effect(() => {
        this.sendPreferences();
      });
    });
    await this.handle.open();
  }

  stop(): void {
    this.stopPreferences?.();
    this.stopPreferences = null;
    this.handle.close();
  }

  private sendPreferences(): void {
    this.handle.send({
      type: 'set_preferences',
      quiet_targets: [...quietTargets()],
      badge_defaults: {
        direct: preferences.badgeDefaultDirect,
        group: preferences.badgeDefaultGroup,
      },
    });
  }

  private resolveListed(): void {
    const rooms = this.rooms;
    for (const waiter of this.listedWaiters) {
      if (rooms.some((room) => room.room_id === waiter.roomId)) waiter.resolve();
    }
  }
}

export const [useRoomList, provideRoomList] = createContext<RoomList>();
