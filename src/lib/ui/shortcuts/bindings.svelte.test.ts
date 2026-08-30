import { beforeEach, expect, test } from 'vitest';

import {
  conflictsWith,
  effectiveShortcuts,
  isRebound,
  rebind,
  resetAllBindings,
  resetBinding,
} from './bindings.svelte';
import { SHORTCUTS } from './shortcuts';

function bindingOf(id: string): string | undefined {
  return effectiveShortcuts().find((shortcut) => shortcut.id === id)?.binding;
}

beforeEach(() => {
  resetAllBindings();
});

test('serves the declared binding until one is overridden', () => {
  expect(bindingOf('app.createRoom')).toBe('mod+shift+n');
  expect(isRebound('app.createRoom')).toBe(false);

  rebind('app.createRoom', 'mod+shift+r');

  expect(bindingOf('app.createRoom')).toBe('mod+shift+r');
  expect(isRebound('app.createRoom')).toBe(true);
});

test('rebinding back to the default drops the override', () => {
  rebind('app.createRoom', 'mod+shift+r');
  rebind('app.createRoom', 'mod+shift+n');

  expect(isRebound('app.createRoom')).toBe(false);
});

test('resetting restores the declared binding', () => {
  rebind('app.createRoom', 'mod+shift+r');
  resetBinding('app.createRoom');

  expect(bindingOf('app.createRoom')).toBe('mod+shift+n');
});

test('names the shortcut a candidate binding would collide with', () => {
  expect(conflictsWith('app.createRoom', 'mod+k', false)).toEqual(['navigation.openRoomSearch']);
  expect(conflictsWith('app.createRoom', 'mod+shift+j', false)).toEqual([]);
});

test('a collision is measured against the overrides, not the defaults', () => {
  rebind('navigation.openRoomSearch', 'mod+j');

  expect(conflictsWith('app.createRoom', 'mod+k', false)).toEqual([]);
  expect(conflictsWith('app.createRoom', 'mod+j', false)).toEqual(['navigation.openRoomSearch']);
});

test('every declared shortcut starts free of conflicts', () => {
  for (const shortcut of SHORTCUTS) {
    expect(conflictsWith(shortcut.id, shortcut.binding, false)).toEqual([]);
    expect(conflictsWith(shortcut.id, shortcut.binding, true)).toEqual([]);
  }
});
