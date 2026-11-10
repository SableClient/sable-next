import { SvelteSet } from 'svelte/reactivity';

import { stringList } from '#lib/guards.js';
import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-bridged-spaces';

const bridged = new SvelteSet<string>(readJson(STORAGE_KEY, stringList, []));

export function bridgedSpaces(): string[] {
  return [...bridged];
}

export function adoptBridgedSpaces(roomIds: string[]): void {
  bridged.clear();
  for (const roomId of roomIds) bridged.add(roomId);
  persist();
}

function persist(): void {
  writeJson(STORAGE_KEY, [...bridged], '[sable nav] bridged spaces not stored');
}

export function isBridgedSpace(roomId: string | null): boolean {
  return roomId !== null && bridged.has(roomId);
}

export function setBridgedSpace(roomId: string, value: boolean): void {
  if (value) bridged.add(roomId);
  else bridged.delete(roomId);
  persist();
}
