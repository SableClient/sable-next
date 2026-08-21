export type AutocompleteSigil = '@' | '#' | ':';

export interface Suggestion {
  id: string;
  insert: string;
  label: string;
  detail?: string | null;
  avatarUrl?: string | null;
  imageUrl?: string | null;
}

export interface AutocompleteQuery {
  sigil: AutocompleteSigil;
  /** Text between the sigil and the caret. */
  query: string;
  /** Index of the sigil in the draft. */
  start: number;
  /** Caret position, i.e. the end of the replaceable range. */
  end: number;
}

const sigils: AutocompleteSigil[] = ['@', '#', ':'];
const maxQueryLength = 32;

/**
 * A sigil only opens a query at the start of the draft or after whitespace, so
 * an email address or a `http://` never turns into a picker.
 */
export function activeQuery(draft: string, caret: number): AutocompleteQuery | null {
  const upToCaret = draft.slice(0, caret);

  for (const sigil of sigils) {
    const start = upToCaret.lastIndexOf(sigil);
    if (start === -1) continue;

    const before = start === 0 ? '' : upToCaret[start - 1];
    if (before !== '' && !/\s/.test(before)) continue;

    const query = upToCaret.slice(start + 1);
    if (query.length === 0 || query.length > maxQueryLength) continue;
    if (/\s/.test(query) || (sigil !== '#' && query.includes(':'))) continue;

    return { sigil, query, start, end: caret };
  }

  return null;
}

export function replaceQuery(draft: string, query: AutocompleteQuery, insert: string): string {
  return `${draft.slice(0, query.start)}${insert}${draft.slice(query.end)}`;
}
