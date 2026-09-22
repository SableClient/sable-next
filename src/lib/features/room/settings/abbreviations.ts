export const ABBREVIATIONS_EVENT_TYPE = 'moe.sable.room.abbreviations';

export interface AbbreviationEntry {
  term: string;
  definition: string;
  cased?: boolean;
}

export function abbreviationKey(entry: AbbreviationEntry): string {
  return entry.cased === true ? `cased:${entry.term}` : `uncased:${entry.term.toLocaleLowerCase()}`;
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

export function readAbbreviations(content: unknown): AbbreviationEntry[] {
  if (typeof content !== 'object' || content === null) return [];

  const entries = (content as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const candidate = entry as { term?: unknown; definition?: unknown; cased?: unknown };
    if (typeof candidate.term !== 'string' || typeof candidate.definition !== 'string') return [];
    if (candidate.term.trim() === '') return [];
    return [
      {
        term: candidate.term,
        definition: candidate.definition,
        ...(candidate.cased === true ? { cased: true } : {}),
      },
    ];
  });
}
