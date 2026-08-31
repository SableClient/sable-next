import {
  tagForLevel,
  type PowerLevelTag,
  type PowerLevelTagMap,
} from './settings/power-level-tags';

const INFINITE_POWER_LEVEL = 2_147_483_647;

const DEFAULT_TAGS: readonly { level: number; key: string }[] = [
  { level: INFINITE_POWER_LEVEL, key: 'timeline.powerTagFounder' },
  { level: 150, key: 'timeline.powerTagManager' },
  { level: 101, key: 'timeline.powerTagFounder' },
  { level: 100, key: 'timeline.powerLevelAdmin' },
  { level: 50, key: 'timeline.powerLevelModerator' },
  { level: 0, key: 'timeline.powerLevelMember' },
  { level: -1, key: 'timeline.powerLevelMuted' },
];

type Translate = (key: string, options?: Record<string, unknown>) => string;

function named(level: number, t: Translate, tags: PowerLevelTagMap): PowerLevelTag | null {
  const room = tagForLevel(tags, level);
  if (room) return room;

  const fallback = DEFAULT_TAGS.find((tag) => tag.level === level);
  return fallback ? { name: t(fallback.key), color: null } : null;
}

export function powerTag(level: number, t: Translate, tags: PowerLevelTagMap = {}): PowerLevelTag {
  const exact = named(level, t, tags);
  if (exact) return exact;

  const levels = [
    ...new Set([...Object.keys(tags).map(Number), ...DEFAULT_TAGS.map((tag) => tag.level)]),
  ].toSorted((left, right) => right - left);

  const below = levels.find((candidate) => candidate < level);
  const tag = below === undefined ? null : named(below, t, tags);

  return {
    name: tag
      ? t('timeline.powerTagDerived', { tag: tag.name, level })
      : t('timeline.powerTagTeam', { level }),
    color: tag?.color ?? null,
  };
}
