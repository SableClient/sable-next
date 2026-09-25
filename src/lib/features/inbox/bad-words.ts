import { array as listedWords } from 'badwords-list';

const EXTRA_WORDS = ['torture', 't0rture'];

const escape = (word: string): string => word.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');

const BAD_WORDS = new RegExp(
  `(\\b|_)(${[...new Set([...EXTRA_WORDS, ...listedWords])].map(escape).join('|')})(\\b|_)`
);

export function hasBadWords(...texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((text) => text != null && BAD_WORDS.test(text.toLowerCase()));
}
