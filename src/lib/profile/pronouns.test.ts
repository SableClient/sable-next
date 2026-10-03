import { expect, test } from 'vitest';

import { pronounSets, pronounText } from './pronouns';

test('splits on commas and reads a leading language tag', () => {
  expect(pronounSets(' she/her, FR:elle ,, ')).toEqual([
    { summary: 'she/her', language: 'en' },
    { summary: 'elle', language: 'fr' },
  ]);
});

test('an empty field is no pronouns at all', () => {
  expect(pronounSets('  ')).toEqual([]);
});

test('a summary is cut at 16 characters', () => {
  expect(pronounSets('a'.repeat(20))[0]?.summary).toHaveLength(16);
});

test('formats a set back as the text that parses to it', () => {
  const sets = [
    { summary: 'they/them', language: 'en' },
    { summary: 'it/its', language: null },
  ];
  expect(pronounText(sets)).toBe('en:they/them, it/its');
});
