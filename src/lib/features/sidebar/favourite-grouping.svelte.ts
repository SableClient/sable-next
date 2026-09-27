import { SvelteSet } from 'svelte/reactivity';

import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-ungrouped-favourites';

const ungrouped = new SvelteSet<string>(readJson(STORAGE_KEY, parseUngroupedFavourites, []));

export function parseUngroupedFavourites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function ungroupedFavourites(): string[] {
  return [...ungrouped];
}

export function adoptUngroupedFavourites(views: string[]): void {
  ungrouped.clear();
  for (const view of views) ungrouped.add(view);
  persist();
}

function persist(): void {
  writeJson(STORAGE_KEY, [...ungrouped], '[sable nav] favourite grouping not stored');
}

export function groupsFavourites(view: string): boolean {
  return !ungrouped.has(view);
}

export function setGroupsFavourites(view: string, grouped: boolean): void {
  if (grouped) ungrouped.delete(view);
  else ungrouped.add(view);
  persist();
}
