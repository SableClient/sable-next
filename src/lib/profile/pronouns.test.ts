import { expect, test } from 'vitest';

import { pronounSets } from './pronouns';

test('splits on commas and reads a trailing language in brackets', () => {
  expect(pronounSets(' she/her, elle (fr) ,, ')).toEqual([
    { summary: 'she/her' },
    { summary: 'elle', language: 'fr' },
  ]);
});

test('an empty field is no pronouns at all', () => {
  expect(pronounSets('  ')).toEqual([]);
});
