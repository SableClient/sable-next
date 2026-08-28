import type { Suggestion } from '../composer/autocomplete';
import { SEARCH_OPERATORS, type SearchOperator } from './search-query';

export interface SuggestionRoom {
  id: string;
  alias: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface SuggestionSender {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SuggestionSources {
  rooms: SuggestionRoom[];
  senders: SuggestionSender[];
  spaces?: SuggestionRoom[];
}

const ATTACHMENT_VALUES = ['image', 'video', 'audio', 'file', 'link'];

const OPERATOR_HINTS: Record<SearchOperator, string> = {
  in: 'room',
  space: 'space',
  from: 'sender',
  mentions: 'pings a user',
  has: 'attachment',
  before: 'YYYY-MM-DD',
  after: 'YYYY-MM-DD',
  during: 'YYYY-MM-DD',
};
const MAX_SUGGESTIONS = 8;
const PARTIAL = /(-?)([A-Za-z]*)(:?)("?)([^"]*)$/;

export interface PartialToken {
  negated: string;
  operator: string;
  hasColon: boolean;
  value: string;
  start: number;
}

export function partialAt(query: string): PartialToken {
  const boundary = lastUnquotedSpace(query);
  const tail = query.slice(boundary + 1);
  const [, negated, operator, colon, , value] = PARTIAL.exec(tail) ?? ['', '', '', '', '', ''];

  return {
    negated,
    operator,
    hasColon: colon === ':',
    value,
    start: boundary + 1,
  };
}

function lastUnquotedSpace(query: string): number {
  let quoted = false;
  let boundary = -1;

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (character === '"') quoted = !quoted;
    else if (character === ' ' && !quoted) boundary = index;
  }

  return boundary;
}

function quoteIfNeeded(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}

function matches(candidate: string, typed: string): boolean {
  return candidate.toLocaleLowerCase().includes(typed.toLocaleLowerCase());
}

export function suggestionsFor(
  query: string,
  sources: SuggestionSources,
  includeOperatorList = false
): Suggestion[] {
  const partial = partialAt(query);

  if (!partial.hasColon) {
    if (partial.operator === '' && !includeOperatorList) return [];
    return SEARCH_OPERATORS.filter((operator) => operator.startsWith(partial.operator))
      .map((operator) => ({
        id: `operator:${operator}`,
        label: `${operator}:`,
        detail: OPERATOR_HINTS[operator],
        insert: `${partial.negated}${operator}:`,
      }))
      .slice(0, MAX_SUGGESTIONS);
  }

  const operator = partial.operator as SearchOperator;
  const prefix = `${partial.negated}${operator}:`;

  switch (operator) {
    case 'in':
      return sources.rooms
        .filter(
          (room) =>
            partial.value === '' ||
            matches(room.alias ?? '', partial.value) ||
            matches(room.name ?? '', partial.value)
        )
        .map((room) => {
          const target = room.alias ?? room.name ?? room.id;
          return {
            id: `room:${room.id}`,
            label: room.name ?? target,
            detail: room.alias,
            avatarUrl: room.avatarUrl,
            insert: `${prefix}${quoteIfNeeded(target)} `,
          };
        })
        .slice(0, MAX_SUGGESTIONS);

    case 'space':
      return (sources.spaces ?? [])
        .filter(
          (space) =>
            partial.value === '' ||
            matches(space.alias ?? '', partial.value) ||
            matches(space.name ?? '', partial.value)
        )
        .map((space) => {
          const target = space.alias ?? space.name ?? space.id;
          return {
            id: `space:${space.id}`,
            label: space.name ?? target,
            detail: space.alias,
            avatarUrl: space.avatarUrl,
            insert: `${prefix}${quoteIfNeeded(target)} `,
          };
        })
        .slice(0, MAX_SUGGESTIONS);

    case 'from':
    case 'mentions':
      return sources.senders
        .filter(
          (sender) =>
            partial.value === '' ||
            matches(sender.userId, partial.value) ||
            matches(sender.displayName, partial.value)
        )
        .map((sender) => ({
          id: `sender:${sender.userId}`,
          label: sender.displayName,
          detail: sender.userId,
          avatarUrl: sender.avatarUrl,
          insert: `${prefix}${sender.userId} `,
        }))
        .slice(0, MAX_SUGGESTIONS);

    case 'has':
      return ATTACHMENT_VALUES.filter(
        (value) => partial.value === '' || value.startsWith(partial.value.toLocaleLowerCase())
      )
        .map((value) => ({
          id: `has:${value}`,
          label: value,
          insert: `${prefix}${value} `,
        }))
        .slice(0, MAX_SUGGESTIONS);

    default:
      return [];
  }
}

export function applySuggestion(query: string, suggestion: Suggestion): string {
  const partial = partialAt(query);
  return `${query.slice(0, partial.start)}${suggestion.insert}`;
}
