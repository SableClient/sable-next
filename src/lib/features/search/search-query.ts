import type { SearchAttachment } from '#src/generated/SearchAttachment';
import type { SearchFilter } from '#src/generated/SearchFilter';

export type SearchOperator = 'in' | 'from' | 'mentions' | 'has' | 'before' | 'after' | 'during';

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
  'from',
  'mentions',
  'has',
  'before',
  'after',
  'during',
];

const UNSUPPORTED_OPERATORS = ['pinned'];
const DATE_OPERATORS = ['before', 'after', 'during'];

const ATTACHMENTS: Record<string, SearchAttachment | undefined> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  sound: 'audio',
  file: 'file',
  link: 'link',
};

const SEGMENT = /-?[A-Za-z]+:"[^"]*"|"[^"]*"|\S+/g;
const DAY_MS = 86_400_000;

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

    if (segment.startsWith('"')) {
      const phrase = segment.slice(1, -1);
      if (phrase.trim() !== '') parsed.phrases.push(phrase);
      continue;
    }

    const negated = segment.startsWith('-');
    const term = negated ? segment.slice(1) : segment;
    if (term === '') continue;

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

    if (
      UNSUPPORTED_OPERATORS.includes(operator) ||
      (negated && DATE_OPERATORS.includes(operator))
    ) {
      parsed.unsupported.push(negated ? `-${operator}` : operator);
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

export interface QueryResolvers {
  roomId: (value: string) => string | undefined;
  userId: (value: string) => string | undefined;
}

export interface ResolvedQuery {
  filter: SearchFilter;
  unresolved: SearchToken[];
}

export function toSearchFilter(parsed: ParsedQuery, resolve: QueryResolvers): ResolvedQuery {
  const unresolved: SearchToken[] = [];
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
  };

  for (const token of parsed.tokens) {
    switch (token.operator) {
      case 'in': {
        const roomId = resolve.roomId(token.value);
        if (roomId) (token.negated ? filter.not_rooms : filter.rooms).push(roomId);
        else unresolved.push(token);
        break;
      }
      case 'from': {
        const userId = resolve.userId(token.value);
        if (userId) (token.negated ? filter.not_senders : filter.senders).push(userId);
        else unresolved.push(token);
        break;
      }
      case 'mentions': {
        const userId = resolve.userId(token.value);
        if (userId) (token.negated ? filter.not_mentions : filter.mentions).push(userId);
        else unresolved.push(token);
        break;
      }
      case 'has': {
        const attachment = ATTACHMENTS[token.value.toLowerCase()];
        if (attachment !== undefined)
          (token.negated ? filter.not_has : filter.has).push(attachment);
        else unresolved.push(token);
        break;
      }
      case 'after': {
        const day = startOfDay(token.value);
        if (day === null) unresolved.push(token);
        else filter.after_ts = day;
        break;
      }
      case 'before': {
        const day = startOfDay(token.value);
        if (day === null) unresolved.push(token);
        else filter.before_ts = day;
        break;
      }
      case 'during': {
        const day = startOfDay(token.value);
        if (day === null) {
          unresolved.push(token);
        } else {
          filter.after_ts = day;
          filter.before_ts = day + DAY_MS - 1;
        }
        break;
      }
    }
  }

  return { filter, unresolved };
}
