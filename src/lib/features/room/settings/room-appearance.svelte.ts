import { SvelteMap } from 'svelte/reactivity';

import { readJson, writeJson } from '#lib/platform/local-json.js';
import type { ShowRoomIcon } from '#lib/settings/preferences.svelte.js';

const STORAGE_KEY = 'sable-room-appearance';
const MODES: readonly ShowRoomIcon[] = ['always', 'sometimes', 'collapsed', 'never'];

const overrides = new SvelteMap<string, ShowRoomIcon>(load());

function load(): [string, ShowRoomIcon][] {
  return readJson(STORAGE_KEY, parseRoomIconOverrides, []);
}

export function parseRoomIconOverrides(value: unknown): [string, ShowRoomIcon][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];

  return Object.entries(value).flatMap(([roomId, mode]) => {
    const known = MODES.find((entry) => entry === mode);
    return known === undefined ? [] : [[roomId, known] as [string, ShowRoomIcon]];
  });
}

export function roomIconOverrides(): Record<string, ShowRoomIcon> {
  return Object.fromEntries(overrides);
}

export function adoptRoomIconOverrides(entries: [string, ShowRoomIcon][]): void {
  overrides.clear();
  for (const [roomId, mode] of entries) overrides.set(roomId, mode);
  persist();
}

function persist(): void {
  writeJson(STORAGE_KEY, Object.fromEntries(overrides), '[sable room] appearance not stored');
}

export function roomIconOverride(roomId: string | null): ShowRoomIcon | null {
  return roomId === null ? null : (overrides.get(roomId) ?? null);
}

export function setRoomIconOverride(roomId: string, mode: ShowRoomIcon | null): void {
  if (mode === null) overrides.delete(roomId);
  else overrides.set(roomId, mode);
  persist();
}

export function showsRoomAvatar(
  mode: ShowRoomIcon,
  collapsed: boolean,
  hasAvatar: boolean
): boolean {
  if (mode === 'always') return true;
  if (mode === 'sometimes') return collapsed || hasAvatar;
  if (mode === 'collapsed') return collapsed;
  return false;
}
