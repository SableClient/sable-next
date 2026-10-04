import { SvelteSet } from 'svelte/reactivity';

import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-dismissed-replaced-rooms';

function parse(parsed: unknown): string[] {
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

const dismissed = new SvelteSet(readJson(STORAGE_KEY, parse, []));

export function isReplacedRoomDismissed(roomId: string): boolean {
  return dismissed.has(roomId);
}

export function dismissReplacedRoom(roomId: string): void {
  dismissed.add(roomId);
  writeJson(STORAGE_KEY, [...dismissed], '[sable] dismissed replaced rooms not persisted');
}
