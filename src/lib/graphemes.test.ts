import { expect, test } from 'vitest';

import { truncateGraphemes } from './graphemes';

test('keeps text within the limit whole', () => {
  expect(truncateGraphemes('héllo', 5)).toBe('héllo');
  expect(truncateGraphemes('', 0)).toBe('');
});

test.each([
  ['a flag', '🇫🇷'],
  ['a ZWJ family', '👩‍👩‍👧‍👦'],
  ['a skin tone', '👍🏽'],
  ['a keycap', '1️⃣'],
  ['a combining mark', 'é'],
])('never splits %s', (_, cluster) => {
  const text = `ab${cluster}${cluster}`;
  for (let limit = 2; limit < 2 + cluster.length; limit += 1) {
    expect(truncateGraphemes(text, limit)).toBe('ab');
  }
  expect(truncateGraphemes(text, 2 + cluster.length)).toBe(`ab${cluster}`);
  expect(truncateGraphemes(text, 1 + 2 * cluster.length)).toBe(`ab${cluster}`);
});

test('cuts a run of flags between flags', () => {
  expect(truncateGraphemes('🇫🇷🇩🇪🇯🇵', 6)).toBe('🇫🇷');
  expect(truncateGraphemes('🇫🇷🇩🇪🇯🇵', 8)).toBe('🇫🇷🇩🇪');
});

test('drops a first cluster longer than the limit whole', () => {
  expect(truncateGraphemes(`e${'\u0301'.repeat(130)}a`, 120)).toBe('');
});
