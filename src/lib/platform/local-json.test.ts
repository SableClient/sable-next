// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { readJson, writeJson } from './local-json.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const parseNumber = (value: unknown): number => {
  if (typeof value !== 'number') throw new Error('not a number');
  return value;
};

test('reads and parses a stored value', () => {
  localStorage.setItem('key', '42');
  expect(readJson('key', parseNumber, 0)).toBe(42);
});

test('falls back when the key is missing, malformed or rejected by the parser', () => {
  expect(readJson('key', parseNumber, 7)).toBe(7);
  localStorage.setItem('key', '{');
  expect(readJson('key', parseNumber, 7)).toBe(7);
  localStorage.setItem('key', '"text"');
  expect(readJson('key', parseNumber, 7)).toBe(7);
});

test('writes the value as JSON', () => {
  writeJson('key', { a: [1] });
  expect(localStorage.getItem('key')).toBe('{"a":[1]}');
});

test('logs a failed write only when given a message', () => {
  vi.stubGlobal('localStorage', {
    setItem: () => {
      throw new Error('quota');
    },
  });
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  writeJson('key', 1);
  expect(debug).not.toHaveBeenCalled();

  writeJson('key', 1, '[sable test] not persisted');
  expect(debug).toHaveBeenCalledWith('[sable test] not persisted', expect.any(Error));
});
