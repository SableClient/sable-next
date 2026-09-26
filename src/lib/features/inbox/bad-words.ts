import { array as listedWords } from 'badwords-list';
import escapeStringRegexp from 'escape-string-regexp';

const EXTRA_WORDS = ['torture', 't0rture'];

const BAD_WORDS = new RegExp(
  `(\\b|_)(${[...new Set([...EXTRA_WORDS, ...listedWords])].map(escapeStringRegexp).join('|')})(\\b|_)`
);

export function hasBadWords(...texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((text) => text != null && BAD_WORDS.test(text.toLowerCase()));
}
