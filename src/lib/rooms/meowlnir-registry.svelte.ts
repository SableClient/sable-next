import { untrack } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord, stringList } from '#lib/guards.js';
import { canSendState } from '#lib/model/model.js';
import { readJson, writeJson } from '#lib/platform/local-json.js';
import type { RoomListItemView } from '#src/generated/protocol';

import {
  PROTECTED_ROOMS_EVENT,
  WATCHED_LISTS_EVENT,
  protectedRooms,
  watchedLists,
} from './meowlnir-config.js';
import { isMeowlnirRoom, loadMeowlnirConfig, type MeowlnirConfig } from './meowlnir.svelte.js';

const STORAGE_KEY = 'sable-meowlnir-rooms';
const PROBED_KEY = 'sable-meowlnir-probed';
const PROBES_AT_ONCE = 4;

export interface MeowlnirList {
  shortcode: string;
  name: string;
}

/** A management room one account can command Meowlnir from, and what it covers. */
export interface MeowlnirRoom {
  roomId: string;
  userId: string;
  protectedRooms: string[];
  lists: MeowlnirList[];
}

function parse(value: unknown): MeowlnirRoom[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.roomId !== 'string' || typeof entry.userId !== 'string')
      return [];
    const lists = Array.isArray(entry.lists) ? entry.lists : [];
    return [
      {
        roomId: entry.roomId,
        userId: entry.userId,
        protectedRooms: stringList(entry.protectedRooms),
        lists: lists.filter(
          (list): list is MeowlnirList =>
            isRecord(list) && typeof list.shortcode === 'string' && typeof list.name === 'string'
        ),
      },
    ];
  });
}

let known = $state.raw<MeowlnirRoom[]>(readJson(STORAGE_KEY, parse, []));
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- nothing renders from this
const refreshed = new Set<string>();

/** Callers run inside effects, which must not come to depend on the list they are updating. */
function current(): MeowlnirRoom[] {
  return untrack(() => known);
}

function store(next: MeowlnirRoom[]): void {
  if (JSON.stringify(next) === JSON.stringify(current())) return;
  known = next;
  writeJson(STORAGE_KEY, next, '[sable room] meowlnir rooms not stored');
}

function without(roomId: string, userId: string): MeowlnirRoom[] {
  return current().filter((entry) => entry.roomId !== roomId || entry.userId !== userId);
}

export function rememberMeowlnirRoom(roomId: string, userId: string, config: MeowlnirConfig): void {
  const entry: MeowlnirRoom = {
    roomId,
    userId,
    protectedRooms: protectedRooms(config.protectedRooms).map((room) => room.roomId),
    // Meowlnir names a list by its short name in commands, so one without cannot be banned into.
    lists: watchedLists(config.watchedLists).flatMap((list) =>
      list.shortcode === null
        ? []
        : [{ shortcode: list.shortcode, name: list.name ?? list.shortcode }]
    ),
  };
  const replaced = current().map((other) =>
    other.roomId === roomId && other.userId === userId ? entry : other
  );
  store(replaced.includes(entry) ? replaced : [...replaced, entry]);
}

export function forgetMeowlnirRoom(roomId: string, userId: string): void {
  store(without(roomId, userId));
}

/** The management room this account can ban from for `roomId`, if Meowlnir protects it. */
export function meowlnirFor(
  roomId: string | null | undefined,
  userId: string | null | undefined
): MeowlnirRoom | null {
  if (!roomId || !userId) return null;
  return (
    known.find(
      (entry) =>
        entry.userId === userId && entry.lists.length > 0 && entry.protectedRooms.includes(roomId)
    ) ?? null
  );
}

async function sync(core: CoreClient, roomId: string, userId: string): Promise<void> {
  try {
    const config = await loadMeowlnirConfig(core, roomId);
    if (config.protectedRooms === null && config.watchedLists === null)
      forgetMeowlnirRoom(roomId, userId);
    else rememberMeowlnirRoom(roomId, userId, config);
  } catch (error) {
    console.debug('[sable room] meowlnir room not refreshed', roomId, error);
  }
}

/**
 * Called as a room opens. `admin` is whether this account may write Meowlnir's
 * settings there, which is also what makes the bot obey its commands, so only
 * rooms it moderates are ever asked for the settings.
 */
export async function noteRoomOpened(
  core: CoreClient,
  roomId: string,
  userId: string,
  admin: boolean
): Promise<void> {
  if (!refreshed.has(userId)) {
    refreshed.add(userId);
    for (const entry of current()) {
      if (entry.userId === userId && entry.roomId !== roomId) void sync(core, entry.roomId, userId);
    }
  }
  const remembered = current().some((entry) => entry.roomId === roomId && entry.userId === userId);
  if (!admin) {
    if (remembered) forgetMeowlnirRoom(roomId, userId);
    return;
  }
  if (remembered || (await isMeowlnirRoom(core, roomId))) await sync(core, roomId, userId);
}

function parseProbed(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([user, ids]) => [user, stringList(ids)]));
}

const probed = readJson(PROBED_KEY, parseProbed, {});
let discovering = false;

async function probe(core: CoreClient, roomId: string, userId: string): Promise<void> {
  const found = await core.rpc.room_state.event({
    room_id: roomId,
    event_type: PROTECTED_ROOMS_EVENT,
    state_key: '',
  });
  if (!isRecord(found)) return;
  const [levels, permissions] = await Promise.all([
    core.rpc.members.powerLevels({ room_id: roomId }),
    core.rpc.members.permissions({ room_id: roomId }),
  ]);
  if (canSendState(levels, permissions.own_power_level, WATCHED_LISTS_EVENT))
    await sync(core, roomId, userId);
}

/**
 * A protected room carries nothing that names its management room, so the ban
 * action there depends on the management room having been seen. This asks each
 * private room once per device, as the room list fills in, instead of waiting
 * for a visit. A room that fails is asked again next time.
 */
export async function discoverMeowlnirRooms(
  core: CoreClient,
  userId: string,
  rooms: readonly RoomListItemView[]
): Promise<void> {
  if (discovering) return;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- nothing renders from this
  const seen = new Set(probed[userId]);
  const candidates = rooms.filter(
    (room) =>
      room.state === 'joined' &&
      !room.is_direct &&
      room.room_kind !== 'space' &&
      room.join_rule !== 'public' &&
      !seen.has(room.room_id)
  );
  if (candidates.length === 0) return;
  discovering = true;
  try {
    for (let at = 0; at < candidates.length; at += PROBES_AT_ONCE) {
      await Promise.all(
        candidates.slice(at, at + PROBES_AT_ONCE).map(async ({ room_id }) => {
          try {
            await probe(core, room_id, userId);
            seen.add(room_id);
          } catch (error) {
            console.debug('[sable room] meowlnir probe failed', room_id, error);
          }
        })
      );
      probed[userId] = [...seen];
      writeJson(PROBED_KEY, probed);
    }
  } finally {
    discovering = false;
  }
}
