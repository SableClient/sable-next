import { expect, test } from 'vitest';

import { parseJsonObject } from './json-object';

test('returns a parsed JSON object', () => {
  expect(parseJsonObject('{"topic":"hi"}')).toEqual({ topic: 'hi' });
});

test('rejects malformed JSON and anything that is not an object', () => {
  for (const text of ['{', '[]', 'null', '1', '"x"', 'true']) {
    expect(parseJsonObject(text)).toBeNull();
  }
});
