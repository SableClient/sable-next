import type { PowerLevelTagView } from '#src/generated/protocol';

import type { PowerLevelTags } from '#lib/core/commands.svelte.js';

export const POWER_LEVEL_TAGS_EVENT_TYPE = 'in.cinny.room.power_level_tags';

export const MIN_POWER_LEVEL = Number.MIN_SAFE_INTEGER;
export const MAX_POWER_LEVEL = Number.MAX_SAFE_INTEGER;
export const FOUNDER_POWER_LEVEL = MAX_POWER_LEVEL + 1;

export type PowerLevelTag = PowerLevelTagView;

export type PowerLevelTagMap = PowerLevelTags;

export type PowerLevelInputResult =
  | { valid: true; level: number }
  | { valid: false; reason: 'not-a-number' | 'out-of-range' | 'exceeds-own' };

export function tagForLevel(tags: PowerLevelTagMap, level: number): PowerLevelTag | null {
  return Object.hasOwn(tags, level) ? tags[level] : null;
}

export function isValidPowerLevel(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_POWER_LEVEL && value <= MAX_POWER_LEVEL;
}

export function parsePowerLevelInput(raw: string, ownLevel: number): PowerLevelInputResult {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return { valid: false, reason: 'not-a-number' };

  const level = Number(trimmed);
  if (!isValidPowerLevel(level)) return { valid: false, reason: 'out-of-range' };
  if (level > ownLevel) return { valid: false, reason: 'exceeds-own' };
  return { valid: true, level };
}
