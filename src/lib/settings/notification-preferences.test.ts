// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

const STORAGE_KEY = 'sable-preferences';

async function loadWith(stored: Record<string, unknown>): Promise<{
  systemNotifications: boolean;
}> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  vi.resetModules();
  const { preferences } = await import('./preferences.svelte');
  return preferences;
}

beforeEach(() => {
  localStorage.clear();
});

test('a reader who turned the web alerts off keeps them off after the merge', async () => {
  const preferences = await loadWith({
    desktopNotifications: false,
    systemNotifications: true,
  });

  expect(preferences.systemNotifications).toBe(false);
});

test('a reader who turned the web alerts on keeps the one switch on', async () => {
  const preferences = await loadWith({
    desktopNotifications: true,
    systemNotifications: true,
  });

  expect(preferences.systemNotifications).toBe(true);
});

test('a native reader who turned the alerts off keeps them off', async () => {
  const preferences = await loadWith({ systemNotifications: false });

  expect(preferences.systemNotifications).toBe(false);
});

test('an install with nothing stored alerts by default', async () => {
  vi.resetModules();
  const { preferences } = await import('./preferences.svelte');

  expect(preferences.systemNotifications).toBe(true);
});
