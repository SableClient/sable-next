import { SvelteSet } from 'svelte/reactivity';

import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-quiet-rooms';
const SHOWN_STORAGE_KEY = 'sable-shown-rooms';

export type UnreadDot = 'default' | 'show' | 'hide';

const quiet = new SvelteSet<string>(readJson(STORAGE_KEY, parseQuietRooms, []));
const shown = new SvelteSet<string>(
  readJson(SHOWN_STORAGE_KEY, parseQuietRooms, []).filter((roomId) => !quiet.has(roomId))
);

export function parseQuietRooms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function quietRooms(): string[] {
  return [...quiet];
}

export function shownRooms(): string[] {
  return [...shown];
}

export function quietTargets(): ReadonlySet<string> {
  return quiet;
}

export function adoptQuietRooms(roomIds: string[]): void {
  quiet.clear();
  for (const roomId of roomIds) quiet.add(roomId);
  persist();
  // Hide wins for a room that a synced document puts on both lists.
  adoptShownRooms([...shown]);
}

export function adoptShownRooms(roomIds: string[]): void {
  shown.clear();
  for (const roomId of roomIds) if (!quiet.has(roomId)) shown.add(roomId);
  persistShown();
}

function persist(): void {
  writeJson(STORAGE_KEY, [...quiet], '[sable nav] quiet rooms not stored');
}

function persistShown(): void {
  writeJson(SHOWN_STORAGE_KEY, [...shown], '[sable nav] shown rooms not stored');
}

export function isQuiet(roomId: string): boolean {
  return quiet.has(roomId);
}

export function setQuiet(roomId: string, value: boolean): void {
  if (value) {
    quiet.add(roomId);
    shown.delete(roomId);
    persistShown();
  } else quiet.delete(roomId);
  persist();
}

export function unreadDot(roomId: string): UnreadDot {
  if (quiet.has(roomId)) return 'hide';
  return shown.has(roomId) ? 'show' : 'default';
}

export function setUnreadDot(roomId: string, dot: UnreadDot): void {
  setQuiet(roomId, dot === 'hide');
  if (dot === 'show') shown.add(roomId);
  else shown.delete(roomId);
  persistShown();
}
