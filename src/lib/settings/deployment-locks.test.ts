// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function loadWith(stored: Record<string, unknown> | null) {
  if (stored) localStorage.setItem('sable-preferences', JSON.stringify(stored));
  const module = await import('./preferences.svelte.js');
  const { settingsDocument } = await import('./sync-documents.js');
  return { ...module, settingsDocument };
}

function persisted(): Record<string, unknown> {
  const { schema: _schema, ...stored } = JSON.parse(
    localStorage.getItem('sable-preferences') ?? '{}'
  ) as Record<string, unknown>;
  return stored;
}

test('a lock overrides an explicit value', async () => {
  const { preferences, applyDeploymentLocks, isLockedPreference } = await loadWith({
    theme: 'light',
  });

  applyDeploymentLocks({ theme: 'dark' });

  expect(preferences.theme).toBe('dark');
  expect(isLockedPreference('theme')).toBe(true);
  expect(isLockedPreference('urlPreviews')).toBe(false);
});

test('setPreference is a no-op for a locked key', async () => {
  const { preferences, applyDeploymentLocks, setPreference } = await loadWith(null);
  applyDeploymentLocks({ theme: 'dark' });

  setPreference('theme', 'light');

  expect(preferences.theme).toBe('dark');
  expect(persisted()).toEqual({});
});

test('applyPreferences skips locked keys and applies the rest', async () => {
  const { preferences, applyDeploymentLocks, applyPreferences, isExplicitPreference } =
    await loadWith(null);
  applyDeploymentLocks({ theme: 'dark' });

  applyPreferences({ ...preferences, theme: 'light', urlPreviews: !preferences.urlPreviews });

  expect(preferences.theme).toBe('dark');
  expect(isExplicitPreference('theme')).toBe(false);
  expect(persisted()).not.toHaveProperty('theme');
  expect(persisted()).toHaveProperty('urlPreviews');
});

test('an invalid locked value is ignored', async () => {
  const { preferences, applyDeploymentLocks, isLockedPreference } = await loadWith({
    theme: 'light',
  });

  applyDeploymentLocks({ theme: 'not-a-theme', urlPreviews: 'yes' });

  expect(preferences.theme).toBe('light');
  expect(isLockedPreference('theme')).toBe(false);
  expect(isLockedPreference('urlPreviews')).toBe(false);
});

test('lifting the lock brings the stored choice back', async () => {
  const first = await loadWith({ theme: 'light' });
  first.applyDeploymentLocks({ theme: 'dark' });
  first.applyPreferences({ ...first.preferences }, ['urlPreviews']);
  expect(persisted().theme).toBe('light');

  vi.resetModules();
  const second = await import('./preferences.svelte.js');

  expect(second.preferences.theme).toBe('light');
});

test('a locked key is not uploaded by settings sync', async () => {
  const { applyDeploymentLocks, settingsDocument } = await loadWith({ theme: 'light' });
  applyDeploymentLocks({ theme: 'dark' });

  const snapshot = settingsDocument.snapshot();
  const settings = (snapshot.content as { settings?: Record<string, unknown> }).settings;

  expect(settings ?? {}).not.toHaveProperty('theme');
});
