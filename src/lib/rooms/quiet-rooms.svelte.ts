import { SvelteSet } from 'svelte/reactivity';

import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-quiet-rooms';

const quiet = new SvelteSet<string>(readJson(STORAGE_KEY, parseQuietRooms, []));

export function parseQuietRooms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function quietRooms(): string[] {
  return [...quiet];
}

export function quietTargets(): ReadonlySet<string> {
  return quiet;
}

export function adoptQuietRooms(roomIds: string[]): void {
  quiet.clear();
  for (const roomId of roomIds) quiet.add(roomId);
  persist();
}

function persist(): void {
  writeJson(STORAGE_KEY, [...quiet], '[sable nav] quiet rooms not stored');
}

export function isQuiet(roomId: string): boolean {
  return quiet.has(roomId);
}

export function setQuiet(roomId: string, value: boolean): void {
  if (value) quiet.add(roomId);
  else quiet.delete(roomId);
  persist();
}
