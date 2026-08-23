import type { ParsedQuery, SearchToken } from './search-query';
import { partialAt } from './search-suggestions';

export interface TokenField {
  chips: SearchToken[];
  draft: string;
}

export function chipText(query: string, chip: SearchToken): string {
  return query.slice(chip.start, chip.end);
}

export function splitTokenField(query: string, parsed: ParsedQuery): TokenField {
  const boundary = partialAt(query).start;
  const chips = parsed.tokens.filter((token) => token.end <= boundary);
  if (chips.length === 0) return { chips, draft: query };

  const parts: string[] = [];
  let cursor = 0;
  for (const chip of chips) {
    parts.push(query.slice(cursor, chip.start));
    cursor = chip.end;
  }
  parts.push(query.slice(cursor));

  let draft = parts[0];
  for (const part of parts.slice(1)) {
    draft += draft.endsWith(' ') && part.startsWith(' ') ? part.slice(1) : part;
  }
  if (chips[0].start === 0 && draft.startsWith(' ')) draft = draft.slice(1);

  return { chips, draft };
}

export function composeQuery(chips: readonly string[], draft: string): string {
  return chips.length === 0 ? draft : [...chips, draft].join(' ');
}
