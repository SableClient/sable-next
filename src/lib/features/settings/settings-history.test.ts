import { expect, test } from 'vitest';

import { SettingsHistory } from './settings-history';

const inSettings = (path: string): boolean => path === '/settings' || path.startsWith('/settings/');

function history(): SettingsHistory {
  return new SettingsHistory(inSettings);
}

test('a section opened from a room is one entry deep', () => {
  const visits = history();
  visits.visit({ type: 'link', fromPath: '/rooms/a' });
  expect(visits.depth).toBe(1);
});

test('a section picked from the menu is one deeper than the menu', () => {
  const visits = history();
  visits.visit({ type: 'link', fromPath: '/rooms/a' });
  visits.visit({ type: 'goto', fromPath: '/settings' });
  expect(visits.depth).toBe(2);
});

test('popping walks the depth back and never below zero', () => {
  const visits = history();
  visits.visit({ type: 'link', fromPath: '/rooms/a' });
  visits.visit({ type: 'goto', fromPath: '/settings' });
  visits.visit({ type: 'popstate', delta: -1, fromPath: '/settings/appearance' });
  expect(visits.depth).toBe(1);
  visits.visit({ type: 'popstate', delta: -5, fromPath: '/settings' });
  expect(visits.depth).toBe(0);
});

test('a page loaded straight onto settings has nothing to pop to', () => {
  const visits = history();
  visits.visit({ type: 'enter', fromPath: null });
  expect(visits.depth).toBe(0);
});

test('a replacing navigation inside settings keeps the depth', () => {
  const visits = history();
  visits.visit({ type: 'enter', fromPath: null });
  visits.replacing();
  visits.visit({ type: 'goto', fromPath: '/settings/appearance' });
  expect(visits.depth).toBe(0);
  visits.visit({ type: 'goto', fromPath: '/settings' });
  expect(visits.depth).toBe(1);
});
