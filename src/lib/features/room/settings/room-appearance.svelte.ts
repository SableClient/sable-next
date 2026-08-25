import { SvelteMap } from 'svelte/reactivity';

import type { ShowRoomIcon } from '#lib/settings/preferences.svelte.js';

const STORAGE_KEY = 'sable-room-appearance';
const MODES: readonly ShowRoomIcon[] = ['always', 'collapsed', 'never'];

const overrides = new SvelteMap<string, ShowRoomIcon>(load());

function load(): [string, ShowRoomIcon][] {
  if (typeof localStorage === 'undefined') return [];

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];

    return Object.entries(parsed).flatMap(([roomId, value]) => {
      const mode = MODES.find((entry) => entry === value);
      return mode === undefined ? [] : [[roomId, mode] as [string, ShowRoomIcon]];
    });
  } catch {
    return [];
  }
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(overrides)));
  } catch (error) {
    console.debug('[sable room] appearance not stored', error);
  }
}

export function roomIconOverride(roomId: string | null): ShowRoomIcon | null {
  return roomId === null ? null : (overrides.get(roomId) ?? null);
}

export function setRoomIconOverride(roomId: string, mode: ShowRoomIcon | null): void {
  if (mode === null) overrides.delete(roomId);
  else overrides.set(roomId, mode);
  persist();
}

export function showsRoomIcon(mode: ShowRoomIcon, collapsed: boolean): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return collapsed;
}
