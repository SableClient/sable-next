import { expect, test } from 'vitest';

import { validateRoomAliasLocalpart } from './room-alias-localpart';

test('accepts a plain localpart', () => {
  expect(validateRoomAliasLocalpart('general')).toBeNull();
});

test('accepts unicode and punctuation outside the reserved set', () => {
  expect(validateRoomAliasLocalpart('café-lounge_42')).toBeNull();
});

test('rejects an empty localpart', () => {
  expect(validateRoomAliasLocalpart('')).toBe('empty');
});

test('rejects a colon, which would split the alias early', () => {
  expect(validateRoomAliasLocalpart('general:extra')).toBe('colon');
});

test('rejects whitespace', () => {
  expect(validateRoomAliasLocalpart('general room')).toBe('whitespace');
  expect(validateRoomAliasLocalpart('\tgeneral')).toBe('whitespace');
});

test('rejects control characters', () => {
  expect(validateRoomAliasLocalpart(`${String.fromCharCode(0)}general`)).toBe('control');
  expect(validateRoomAliasLocalpart(`general${String.fromCharCode(7)}`)).toBe('control');
});
