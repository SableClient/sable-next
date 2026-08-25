export const ABBREVIATIONS_EVENT_TYPE = 'moe.sable.room.abbreviations';

export interface AbbreviationEntry {
  term: string;
  definition: string;
}

export function readAbbreviations(content: unknown): AbbreviationEntry[] {
  if (typeof content !== 'object' || content === null) return [];

  const entries = (content as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const candidate = entry as { term?: unknown; definition?: unknown };
    if (typeof candidate.term !== 'string' || typeof candidate.definition !== 'string') return [];
    if (candidate.term.trim() === '') return [];
    return [{ term: candidate.term, definition: candidate.definition }];
  });
}
