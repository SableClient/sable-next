import type { AbbreviationView } from '#src/generated/protocol';

export const ABBREVIATIONS_EVENT_TYPE = 'moe.sable.room.abbreviations';

export type AbbreviationEntry = AbbreviationView;

export function abbreviationKey(entry: AbbreviationEntry): string {
  return entry.cased ? `cased:${entry.term}` : `uncased:${entry.term.toLocaleLowerCase()}`;
}

export function splitTerms(input: string): string[] {
  return input
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term !== '');
}

export function upsertAbbreviation(
  entries: readonly AbbreviationEntry[],
  replacingKey: string | null,
  updated: AbbreviationEntry
): AbbreviationEntry[] {
  const updatedKey = abbreviationKey(updated);
  const kept = entries.filter(
    (entry) => abbreviationKey(entry) !== replacingKey && abbreviationKey(entry) !== updatedKey
  );
  if (replacingKey === null) return [...kept, updated];

  const index = entries.findIndex((entry) => abbreviationKey(entry) === replacingKey);
  if (index < 0) return [...kept, updated];
  const next = [...kept];
  next.splice(Math.min(index, next.length), 0, updated);
  return next;
}
