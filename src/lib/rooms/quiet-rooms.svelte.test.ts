// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  adoptQuietRooms,
  adoptShownRooms,
  quietRooms,
  setQuiet,
  setUnreadDot,
  shownRooms,
  unreadDot,
} from './quiet-rooms.svelte.js';

const room = '!room:example.org';

function reset(): void {
  adoptQuietRooms([]);
  adoptShownRooms([]);
  localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

it('reports one of three states for a room', () => {
  expect(unreadDot(room)).toBe('default');

  setUnreadDot(room, 'hide');
  expect(unreadDot(room)).toBe('hide');

  setUnreadDot(room, 'show');
  expect(unreadDot(room)).toBe('show');

  setUnreadDot(room, 'default');
  expect(unreadDot(room)).toBe('default');
});

it('keeps a room on one list at a time', () => {
  setUnreadDot(room, 'hide');
  setUnreadDot(room, 'show');
  expect(quietRooms()).toEqual([]);
  expect(shownRooms()).toEqual([room]);

  setQuiet(room, true);
  expect(quietRooms()).toEqual([room]);
  expect(shownRooms()).toEqual([]);
});

it('lets the hidden list win when a synced document lists a room on both', () => {
  adoptShownRooms([room, '!other:example.org']);
  adoptQuietRooms([room]);
  expect(shownRooms()).toEqual(['!other:example.org']);

  adoptQuietRooms([]);
  adoptShownRooms([]);
  adoptQuietRooms([room]);
  adoptShownRooms([room]);
  expect(shownRooms()).toEqual([]);
});

it('stores each list under its own key and reads them back', async () => {
  setUnreadDot(room, 'show');
  setUnreadDot('!hidden:example.org', 'hide');

  expect(JSON.parse(localStorage.getItem('sable-shown-rooms') ?? 'null')).toEqual([room]);
  expect(JSON.parse(localStorage.getItem('sable-quiet-rooms') ?? 'null')).toEqual([
    '!hidden:example.org',
  ]);

  vi.resetModules();
  const fresh = await import('./quiet-rooms.svelte.js');
  expect(fresh.shownRooms()).toEqual([room]);
  expect(fresh.quietRooms()).toEqual(['!hidden:example.org']);
});
