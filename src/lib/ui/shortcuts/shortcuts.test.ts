import { expect, test } from 'vitest';

import { SHORTCUTS, shortcutsConflicts } from './shortcuts';

test('no two shortcuts share a binding on windows/linux', () => {
  expect(shortcutsConflicts(false)).toEqual([]);
});

test('no two shortcuts share a binding on mac', () => {
  expect(shortcutsConflicts(true)).toEqual([]);
});

test('every shortcut id is unique', () => {
  const ids = SHORTCUTS.map((shortcut) => shortcut.id);
  expect(new Set(ids).size).toBe(ids.length);
});
