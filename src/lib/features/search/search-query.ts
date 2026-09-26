import type { SearchAttachment, SearchFilter } from '#src/generated/protocol';

export type SearchOperator =
  | 'in'
  | 'space'
  | 'from'
  | 'mentions'
  | 'has'
  | 'before'
  | 'after'
  | 'during'
  | 'on'
  | 'with'
  | 'is'
  | 'pinned'
  | 'regex';

export interface SearchToken {
  operator: SearchOperator;
  value: string;
  negated: boolean;
  start: number;
  end: number;
}

export interface ParsedQuery {
  text: string;
  phrases: string[];
  exclude: string[];
  tokens: SearchToken[];
  unsupported: string[];
}

export const SEARCH_OPERATORS: readonly SearchOperator[] = [
  'in',
  'space',
  'from',
  'mentions',
  'has',
  'before',
  'after',
  'during',
  'on',
  'with',
  'is',
  'pinned',
  'regex',
];

const DATE_OPERATORS = ['before', 'after', 'during', 'on'];

const ATTACHMENTS: Record<string, SearchAttachment | undefined> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  sound: 'audio',
  file: 'file',
  link: 'link',
  poll: 'poll',
};

const FILE_EXTENSION = /^\.[a-z0-9]{1,10}$/i;
const FILE_TYPES = new Set([
  'pdf',
  'zip',
  'txt',
  'md',
  'csv',
  'json',
  'doc',
  'docx',
  'odt',
  'xls',
  'xlsx',
  'ods',
  'ppt',
  'pptx',
  'odp',
  'gif',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'mp3',
  'ogg',
  'opus',
  'wav',
  'flac',
  'mp4',
  'mkv',
  'webm',
  'mov',
  'apk',
  'exe',
  'tar',
  'gz',
  '7z',
  'rar',
  'iso',
]);

function fileTypeOf(value: string): string | null {
  if (FILE_EXTENSION.test(value)) return value.slice(1);
  return FILE_TYPES.has(value) ? value : null;
}

function patternOf(value: string): RegExp | null {
  if (value.length < 3 || !value.startsWith('/') || !value.endsWith('/')) return null;
  try {
    return new RegExp(value.slice(1, -1), 'iu');
  } catch {
    return null;
  }
}

const SEGMENT = /-?[A-Za-z]+:"[^"]*"|-?"[^"]*"|\S+/g;

function isOperator(candidate: string): candidate is SearchOperator {
  return (SEARCH_OPERATORS as readonly string[]).includes(candidate);
}

export function parseSearchQuery(input: string): ParsedQuery {
  const parsed: ParsedQuery = {
    text: '',
    phrases: [],
    exclude: [],
    tokens: [],
    unsupported: [],
  };
  const words: string[] = [];

  for (const match of input.matchAll(SEGMENT)) {
    const segment = match[0];
    const start = match.index;

    const negated = segment.startsWith('-');
    const term = negated ? segment.slice(1) : segment;
    if (term === '') continue;

    if (term.startsWith('"')) {
      const phrase = term.length > 1 && term.endsWith('"') ? term.slice(1, -1) : term.slice(1);
      if (phrase.trim() !== '') {
        if (negated) parsed.exclude.push(phrase);
        else parsed.phrases.push(phrase);
      }
      continue;
    }

    const separator = term.indexOf(':');
    if (separator <= 0) {
      if (negated) parsed.exclude.push(term);
      else words.push(term);
      continue;
    }

    const operator = term.slice(0, separator).toLowerCase();
    const raw = term.slice(separator + 1);
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (value === '') continue;

    if (negated && DATE_OPERATORS.includes(operator)) {
      parsed.unsupported.push(`-${operator}`);
      continue;
    }
    if (isOperator(operator)) {
      parsed.tokens.push({
        operator,
        value,
        negated,
        start,
        end: start + segment.length,
      });
      continue;
    }

    if (negated) parsed.exclude.push(term);
    else words.push(term);
  }

  parsed.text = words.join(' ');
  return parsed;
}

function startOfDay(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00`);
  return Number.isNaN(parsed) ? null : parsed;
}

function periodOf(value: string): [number, number] | null {
  if (!/^\d{4}(-\d{2}){0,2}$/.test(value)) return null;
  const parts = value.split('-');
  const start = startOfDay([...parts, '01', '01'].slice(0, 3).join('-'));
  if (start === null) return null;

  const end = new Date(start);
  if (parts.length === 3) end.setDate(end.getDate() + 1);
  else if (parts.length === 2) end.setMonth(end.getMonth() + 1);
  else end.setFullYear(end.getFullYear() + 1);
  return [start, end.getTime() - 1];
}

export interface QueryResolvers {
  roomId: (value: string) => string | undefined;
  userId: (value: string) => string | undefined;
  usersMatching?: (pattern: RegExp) => string[];
  spaceRooms: (value: string) => string[] | undefined;
  directRooms: (value: string) => string[] | undefined;
}

export interface ResolvedQuery {
  filter: SearchFilter;
  unresolved: SearchToken[];
  matchesNothing: boolean;
}

function laterOf(current: number | null, next: number): number {
  return current === null ? next : Math.max(current, next);
}

function earlierOf(current: number | null, next: number): number {
  return current === null ? next : Math.min(current, next);
}

export function toSearchFilter(parsed: ParsedQuery, resolve: QueryResolvers): ResolvedQuery {
  const unresolved: SearchToken[] = [];
  let matchesNothing = false;
  const filter: SearchFilter = {
    rooms: [],
    senders: [],
    mentions: [],
    has: [],
    not_rooms: [],
    not_senders: [],
    not_mentions: [],
    not_has: [],
    after_ts: null,
    before_ts: null,
    phrases: [...parsed.phrases],
    exclude: [...parsed.exclude],
    pinned: null,
    in_thread: null,
    file_types: [],
    not_file_types: [],
    pattern: null,
    state_events: null,
  };

  for (const token of parsed.tokens) {
    switch (token.operator) {
      case 'in': {
        const roomId = resolve.roomId(token.value);
        const children = roomId === undefined ? undefined : resolve.spaceRooms(roomId);
        if (roomId === undefined) unresolved.push(token);
        else if (children === undefined)
          (token.negated ? filter.not_rooms : filter.rooms).push(roomId);
        else if (token.negated) filter.not_rooms.push(...children);
        else if (children.length === 0) matchesNothing = true;
        else filter.rooms.push(...children);
        break;
      }
      case 'space': {
        const roomIds = resolve.spaceRooms(token.value);
        if (roomIds === undefined) unresolved.push(token);
        else if (token.negated) filter.not_rooms.push(...roomIds);
        else if (roomIds.length === 0) matchesNothing = true;
        else filter.rooms.push(...roomIds);
        break;
      }
      case 'from':
      case 'mentions': {
        const pattern = patternOf(token.value);
        const userIds = pattern
          ? (resolve.usersMatching?.(pattern) ?? [])
          : [resolve.userId(token.value)].filter((userId) => userId !== undefined);
        const wanted = token.operator === 'from' ? filter.senders : filter.mentions;
        const denied = token.operator === 'from' ? filter.not_senders : filter.not_mentions;
        if (userIds.length === 0) unresolved.push(token);
        else (token.negated ? denied : wanted).push(...userIds);
        break;
      }
      case 'has': {
        const value = token.value.toLowerCase();
        const attachment = ATTACHMENTS[value];
        if (value === 'pin') filter.pinned = !token.negated;
        else if (attachment !== undefined)
          (token.negated ? filter.not_has : filter.has).push(attachment);
        else if (fileTypeOf(value) !== null)
          (token.negated ? filter.not_file_types : filter.file_types).push(
            fileTypeOf(value) ?? value
          );
        else unresolved.push(token);
        break;
      }
      case 'regex': {
        const source = patternOf(token.value)?.source ?? token.value;
        if (token.negated) unresolved.push(token);
        else filter.pattern = source;
        break;
      }
      case 'after': {
        const day = startOfDay(token.value);
        if (day === null) unresolved.push(token);
        else filter.after_ts = laterOf(filter.after_ts, day);
        break;
      }
      case 'before': {
        const day = startOfDay(token.value);
        if (day === null) unresolved.push(token);
        else filter.before_ts = earlierOf(filter.before_ts, day);
        break;
      }
      case 'during':
      case 'on': {
        const period =
          token.operator === 'on' && token.value.split('-').length !== 3
            ? null
            : periodOf(token.value);
        if (period === null) {
          unresolved.push(token);
        } else {
          filter.after_ts = laterOf(filter.after_ts, period[0]);
          filter.before_ts = earlierOf(filter.before_ts, period[1]);
        }
        break;
      }
      case 'with': {
        const roomIds = resolve.directRooms(token.value);
        if (roomIds) (token.negated ? filter.not_rooms : filter.rooms).push(...roomIds);
        else unresolved.push(token);
        break;
      }
      case 'is': {
        const value = token.value.toLowerCase();
        if (value === 'thread') filter.in_thread = !token.negated;
        else if (value === 'state') filter.state_events = !token.negated;
        else unresolved.push(token);
        break;
      }
      case 'pinned': {
        const value = token.value.toLowerCase();
        if (value === 'true' || value === 'false')
          filter.pinned = (value === 'true') !== token.negated;
        else unresolved.push(token);
        break;
      }
    }
  }

  return { filter, unresolved, matchesNothing };
}
