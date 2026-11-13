import { untrack } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord, stringList } from '#lib/guards.js';
import { readJson, writeJson } from '#lib/platform/local-json.js';

import { protectedRooms, watchedLists } from './meowlnir-config.js';
import { isMeowlnirRoom, loadMeowlnirConfig, type MeowlnirConfig } from './meowlnir.svelte.js';

const STORAGE_KEY = 'sable-meowlnir-rooms';

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
