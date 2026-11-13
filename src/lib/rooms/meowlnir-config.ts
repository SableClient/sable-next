import { isRecord, stringList } from '#lib/guards.js';

export const PROTECTED_ROOMS_EVENT = 'fi.mau.meowlnir.protected_rooms';
export const WATCHED_LISTS_EVENT = 'fi.mau.meowlnir.watched_lists';

/** Event content as the server holds it, so keys this client does not model survive a rewrite. */
export type RawContent = Record<string, unknown>;

export interface ProtectedRoom {
  roomId: string;
  skipAcl: boolean;
}

export const LIST_FLAGS = [
  'dont_apply',
  'dont_apply_acl',
  'auto_unban',
  'auto_suspend',
  'dont_notify_on_change',
] as const;

export type ListFlag = (typeof LIST_FLAGS)[number];

export interface WatchedList extends Record<ListFlag, boolean> {
  roomId: string;
  name: string | null;
  shortcode: string | null;
}

export interface ProtectionField {
  key: string;
  kind: 'switch' | 'number' | 'patterns';
}

export interface ProtectionDefinition {
  name: string;
  experimental: boolean;
  fields: readonly ProtectionField[];
}

const RATE_FIELDS: readonly ProtectionField[] = [
  { key: 'limit', kind: 'number' },
  { key: 'per', kind: 'number' },
];

export const PROTECTIONS: readonly ProtectionDefinition[] = [
  {
    name: 'no_media',
    experimental: false,
    fields: [
      'allow_images',
      'allow_videos',
      'allow_audio',
      'allow_files',
      'allow_stickers',
      'allow_unknown_msgtypes',
      'deny_custom_reactions',
      'deny_inline_images',
    ].map((key) => ({ key, kind: 'switch' })),
  },
  { name: 'well_formed_event', experimental: false, fields: [] },
  {
    name: 'anti_flood',
    experimental: true,
    fields: [...RATE_FIELDS, { key: 'max_infractions', kind: 'number' }],
  },
  {
    name: 'max_mentions',
    experimental: true,
    fields: [
      ...RATE_FIELDS,
      { key: 'max_infractions', kind: 'number' },
      { key: 'must_have_mentions', kind: 'switch' },
    ],
  },
  { name: 'join_rate', experimental: true, fields: RATE_FIELDS },
  { name: 'bad_words', experimental: true, fields: [{ key: 'patterns', kind: 'patterns' }] },
  { name: 'bad_displaynames', experimental: true, fields: [{ key: 'patterns', kind: 'patterns' }] },
  { name: 'insecure_registration', experimental: true, fields: [] },
];

export function isRoomId(value: string): boolean {
  return /^![^\s]+$/.test(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function protectedRooms(content: RawContent | null): ProtectedRoom[] {
  const skipped = new Set(stringList(content?.skip_acl));
  return unique(stringList(content?.rooms)).map((roomId) => ({
    roomId,
    skipAcl: skipped.has(roomId),
  }));
}

export function addProtectedRoom(content: RawContent, roomId: string): RawContent {
  return { ...content, rooms: unique([...stringList(content.rooms), roomId]) };
}

export function removeProtectedRoom(content: RawContent, roomId: string): RawContent {
  return {
    ...content,
    rooms: stringList(content.rooms).filter((id) => id !== roomId),
    skip_acl: stringList(content.skip_acl).filter((id) => id !== roomId),
  };
}

export function setSkipAcl(content: RawContent, roomId: string, skip: boolean): RawContent {
  const others = stringList(content.skip_acl).filter((id) => id !== roomId);
  return { ...content, skip_acl: skip ? [...others, roomId] : others };
}

function rawLists(content: RawContent | null): RawContent[] {
  const lists: unknown = content?.lists;
  if (!Array.isArray(lists)) return [];
  const seen = new Set<string>();
  return lists.filter((list): list is RawContent => {
    if (!isRecord(list) || typeof list.room_id !== 'string' || seen.has(list.room_id)) return false;
    seen.add(list.room_id);
    return true;
  });
}

/** In precedence order: when two lists disagree, Meowlnir follows the earlier one. */
export function watchedLists(content: RawContent | null): WatchedList[] {
  return rawLists(content).map((list) => ({
    roomId: list.room_id as string,
    name: text(list.name),
    shortcode: text(list.shortcode),
    dont_apply: list.dont_apply === true,
    dont_apply_acl: list.dont_apply_acl === true,
    auto_unban: list.auto_unban === true,
    auto_suspend: list.auto_suspend === true,
    dont_notify_on_change: list.dont_notify_on_change === true,
  }));
}

/** New lists unban when a rule is removed, as `!lists subscribe` does. */
export function addWatchedList(content: RawContent, roomId: string, shortcode: string): RawContent {
  const lists = rawLists(content);
  if (lists.some((list) => list.room_id === roomId)) return content;
  return { ...content, lists: [...lists, { room_id: roomId, shortcode, auto_unban: true }] };
}

export function removeWatchedList(content: RawContent, roomId: string): RawContent {
  return { ...content, lists: rawLists(content).filter((list) => list.room_id !== roomId) };
}

export function moveWatchedList(content: RawContent, roomId: string, by: -1 | 1): RawContent {
  const lists = rawLists(content);
  const from = lists.findIndex((list) => list.room_id === roomId);
  const to = from + by;
  if (from === -1 || to < 0 || to >= lists.length) return content;
  [lists[from], lists[to]] = [lists[to], lists[from]];
  return { ...content, lists };
}

export function setWatchedListFlag(
  content: RawContent,
  roomId: string,
  flag: ListFlag,
  value: boolean
): RawContent {
  return {
    ...content,
    lists: rawLists(content).map((list) =>
      list.room_id === roomId ? { ...list, [flag]: value } : list
    ),
  };
}

function rawProtections(content: RawContent | null): Record<string, unknown> {
  return isRecord(content?.protections) ? content.protections : {};
}

/** `null` while the protection is off: Meowlnir enables one by the presence of its key. */
export function protectionConfig(content: RawContent | null, name: string): RawContent | null {
  const protections = rawProtections(content);
  if (!(name in protections)) return null;
  const config = protections[name];
  return isRecord(config) ? config : {};
}

export function unknownProtections(content: RawContent | null): string[] {
  const known = new Set(PROTECTIONS.map((protection) => protection.name));
  return Object.keys(rawProtections(content)).filter((name) => !known.has(name));
}

export function setProtectionEnabled(
  content: RawContent,
  name: string,
  enabled: boolean
): RawContent {
  const { [name]: current, ...others } = rawProtections(content);
  if (enabled) return { ...content, protections: { ...others, [name]: current ?? {} } };
  const { protections: _, ...rest } = content;
  return Object.keys(others).length === 0 ? rest : { ...rest, protections: others };
}

export function setProtectionField(
  content: RawContent,
  name: string,
  key: string,
  value: unknown
): RawContent {
  return {
    ...content,
    protections: {
      ...rawProtections(content),
      [name]: { ...protectionConfig(content, name), [key]: value },
    },
  };
}

export function patternLines(value: string): string[] {
  return unique(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  );
}
