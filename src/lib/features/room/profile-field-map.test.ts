import { expect, test } from 'vitest';

import { profileFieldJson, profileFieldMap, profileFieldPreview } from './profile-field-map';

test('the preview keeps the first 256 characters, not code units', () => {
  expect(profileFieldPreview('🐈‍⬛'.repeat(300))).toBe('🐈‍⬛'.repeat(256));
});

test('an object or array is pretty-printed, anything else is left as is', () => {
  expect(profileFieldJson('["a","b"]')).toBe('[\n  "a",\n  "b"\n]');
  expect(profileFieldJson('sleepy')).toBe('sleepy');
  expect(profileFieldJson('null')).toBe('null');
});

test('a flat map of strings, numbers and booleans becomes key/value pairs', () => {
  expect(profileFieldMap('{"site":"https://example.org","age":3,"cat":true}')).toEqual([
    ['site', 'https://example.org'],
    ['age', '3'],
    ['cat', 'true'],
  ]);
});

test('a nested object, array or null value is not a flat map', () => {
  expect(profileFieldMap('{"a":"b","c":{"d":"e"}}')).toBeNull();
  expect(profileFieldMap('{"a":"b","c":["d"]}')).toBeNull();
  expect(profileFieldMap('{"a":"b","c":null}')).toBeNull();
});

test('anything that is not an object is not a map', () => {
  expect(profileFieldMap('sleepy')).toBeNull();
  expect(profileFieldMap('["a","b"]')).toBeNull();
  expect(profileFieldMap('null')).toBeNull();
  expect(profileFieldMap('42')).toBeNull();
  expect(profileFieldMap('"text"')).toBeNull();
});

test('an empty or truncated object is not a map', () => {
  expect(profileFieldMap('{}')).toBeNull();
  expect(profileFieldMap('{"a":"b","c":"d')).toBeNull();
});
