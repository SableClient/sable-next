import { expect, test } from 'vitest';

import { toInitials } from './initials.js';

test('upper-cases the first glyph', () => {
  expect(toInitials('erwan')).toBe('E');
});

test('skips the matrix sigil rather than rendering it', () => {
  expect(toInitials('@erwan:sable.moe')).toBe('E');
  expect(toInitials('#sable:sable.moe')).toBe('S');
  expect(toInitials('!abc:sable.moe')).toBe('A');
});

test('keeps an astral glyph whole', () => {
  expect(toInitials('🎉 party')).toBe('🎉');
});

test('falls back to a question mark when there is nothing to show', () => {
  expect(toInitials(null)).toBe('?');
  expect(toInitials('   ')).toBe('?');
});

test('takes more than one glyph when asked', () => {
  expect(toInitials('sable emotes', 2)).toBe('SA');
});

test('keeps a multi-code-point grapheme whole', () => {
  expect(toInitials('👩‍👩‍👧 family room')).toBe('👩‍👩‍👧');
  expect(toInitials('🇫🇷 france')).toBe('🇫🇷');
});
