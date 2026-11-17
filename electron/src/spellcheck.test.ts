import { expect, test } from 'vitest';

import { spellCheckerLanguages } from './spellcheck';

const available = ['de', 'en', 'en-GB', 'en-US'];

test('picks one dictionary per language', () => {
  expect(spellCheckerLanguages(['en-GB', 'en'], available)).toEqual(['en-GB']);
  expect(spellCheckerLanguages(['en-US', 'en'], available)).toEqual(['en-US']);
});

test('falls back to en-GB for other English regions', () => {
  expect(spellCheckerLanguages(['en-IE', 'en'], available)).toEqual(['en-GB']);
});

test('falls back to the bare language', () => {
  expect(spellCheckerLanguages(['de-AT', 'de', 'xx-YY'], available)).toEqual(['de']);
});
