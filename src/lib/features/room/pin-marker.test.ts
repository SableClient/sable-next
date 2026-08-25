import { expect, test } from 'vitest';

import { isNewPin, pinsHash, unreadPinCount, type PinReadMarker } from './pin-marker';

function marker(lastSeenId: string, count: number, hash: string): PinReadMarker {
  return { hash, count, last_seen_id: lastSeenId };
}

test('the hash ignores order, so a reorder alone is not a new pin', async () => {
  const one = await pinsHash(['$a', '$b', '$c']);
  const other = await pinsHash(['$c', '$a', '$b']);

  expect(one).toBe(other);
  expect(one).toHaveLength(10);
});

test('the hash changes when the set changes', async () => {
  expect(await pinsHash(['$a', '$b'])).not.toBe(await pinsHash(['$a', '$b', '$c']));
});

test('never seen means every pin is unread', () => {
  expect(unreadPinCount(['$a', '$b'], null, 'hash')).toBe(2);
  expect(isNewPin(['$a', '$b'], null, '$a')).toBe(true);
});

test('an unchanged set reads as fully seen', async () => {
  const ids = ['$a', '$b'];
  const hash = await pinsHash(ids);

  expect(unreadPinCount(ids, marker('$b', 2, hash), hash)).toBe(0);
});

test('only the pins after the marker count as unread', () => {
  const ids = ['$a', '$b', '$c', '$d'];
  const seen = marker('$b', 2, 'stale');

  expect(unreadPinCount(ids, seen, 'current')).toBe(2);
  expect(isNewPin(ids, seen, '$b')).toBe(false);
  expect(isNewPin(ids, seen, '$c')).toBe(true);
});

test('a marker whose pin was unpinned falls back to the stored count', () => {
  const ids = ['$b', '$c', '$d'];
  const seen = marker('$gone', 2, 'stale');

  // Two were seen, so everything from the second onward is treated as new.
  expect(unreadPinCount(ids, seen, 'current')).toBe(2);
  expect(isNewPin(ids, seen, '$b')).toBe(false);
  expect(isNewPin(ids, seen, '$c')).toBe(true);
  expect(isNewPin(ids, seen, '$d')).toBe(true);
});

test('an empty room has nothing unread', () => {
  expect(unreadPinCount([], null, null)).toBe(0);
});
