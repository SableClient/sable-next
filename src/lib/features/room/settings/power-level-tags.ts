export const POWER_LEVEL_TAGS_EVENT_TYPE = 'in.cinny.room.power_level_tags';

export const MIN_POWER_LEVEL = Number.MIN_SAFE_INTEGER;
export const MAX_POWER_LEVEL = Number.MAX_SAFE_INTEGER;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export interface PowerLevelTag {
  readonly name: string;
  readonly color: string | null;
}

export type PowerLevelTagMap = Readonly<Record<number, PowerLevelTag>>;

export type PowerLevelInputResult =
  | { valid: true; level: number }
  | { valid: false; reason: 'not-a-number' | 'out-of-range' | 'exceeds-own' };

function parseTag(value: unknown): PowerLevelTag | null {
  if (typeof value !== 'object' || value === null) return null;
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== 'string' || name.trim() === '') return null;
  const color = (value as Record<string, unknown>).color;
  return { name, color: typeof color === 'string' && HEX_COLOR.test(color) ? color : null };
}

export function parsePowerLevelTags(content: unknown): PowerLevelTagMap {
  if (typeof content !== 'object' || content === null) return {};

  const tags: Record<number, PowerLevelTag> = {};
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (!/^-?\d+$/.test(key)) continue;
    const level = Number(key);
    if (!isValidPowerLevel(level)) continue;
    const tag = parseTag(value);
    if (tag) tags[level] = tag;
  }
  return tags;
}

export function tagForLevel(tags: PowerLevelTagMap, level: number): PowerLevelTag | null {
  return tags[level] ?? null;
}

export function withPowerLevelTag(
  rawContent: unknown,
  level: number,
  tag: { name: string; color: string | null } | null
): Record<string, unknown> {
  const base = typeof rawContent === 'object' && rawContent !== null ? rawContent : {};
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const key = String(level);

  if (tag === null) {
    const { [key]: _removed, ...rest } = next;
    return rest;
  }

  const existing = next[key];
  const existingFields = typeof existing === 'object' && existing !== null ? existing : {};
  next[key] = tag.color
    ? { ...existingFields, name: tag.name, color: tag.color }
    : { ...existingFields, name: tag.name, color: undefined };
  return next;
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
