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
  return JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as Record<string, unknown>;
}

function syncedSettings(snapshot: { content: unknown }): Record<string, unknown> {
  return (snapshot.content as { settings: Record<string, unknown> }).settings;
}

test('a deployment default applies to a key the reader never set', async () => {
  const { preferences, applyDeploymentDefaults } = await loadWith(null);

  applyDeploymentDefaults({ theme: 'dark', urlPreviews: true });

  expect(preferences.theme).toBe('dark');
  expect(preferences.urlPreviews).toBe(true);
});

test('a stored choice beats the deployment default', async () => {
  const { preferences, applyDeploymentDefaults } = await loadWith({ theme: 'light' });

  applyDeploymentDefaults({ theme: 'dark' });

  expect(preferences.theme).toBe('light');
});

test('a choice made before the config arrives beats the deployment default', async () => {
  const { preferences, applyDeploymentDefaults, setPreference } = await loadWith(null);

  setPreference('theme', 'light');
  applyDeploymentDefaults({ theme: 'dark' });

  expect(preferences.theme).toBe('light');
});

test('an invalid deployment value leaves the built-in default', async () => {
  const { preferences, applyDeploymentDefaults } = await loadWith(null);

  applyDeploymentDefaults({ theme: 'sepia', urlPreviews: 'yes' });

  expect(preferences.theme).toBe('system');
  expect(preferences.urlPreviews).toBe(false);
});

test('persisting another key does not store the deployment default as a choice', async () => {
  const { applyDeploymentDefaults, setPreference } = await loadWith(null);

  applyDeploymentDefaults({ theme: 'dark' });
  setPreference('urlPreviews', true);

  expect(persisted()).toEqual({ urlPreviews: true });
});

test('choosing the deployment value explicitly keeps it across a changed default', async () => {
  const { applyDeploymentDefaults, setPreference } = await loadWith(null);

  applyDeploymentDefaults({ theme: 'dark' });
  setPreference('theme', 'dark');

  expect(persisted()).toEqual({ theme: 'dark' });
});

test('settings sync uploads choices, never deployment defaults', async () => {
  const { applyDeploymentDefaults, setPreference, settingsDocument } = await loadWith(null);

  applyDeploymentDefaults({ theme: 'dark', hour24Clock: true });
  setPreference('urlPreviews', true);

  expect(syncedSettings(settingsDocument.snapshot())).toEqual({ urlPreviews: true });
});

test('a synced choice is not overridden by a deployment default that arrives later', async () => {
  const { preferences, applyDeploymentDefaults, settingsDocument } = await loadWith(null);

  const remote = {
    v: 1,
    settings: { theme: 'system' },
    themes: { themes: [], tweaks: [], lightThemeId: null, darkThemeId: null, enabledTweakIds: [] },
  };
  expect(settingsDocument.adopt(remote)).toBe(true);
  applyDeploymentDefaults({ theme: 'dark', hour24Clock: true });

  expect(preferences.theme).toBe('system');
  expect(preferences.hour24Clock).toBe(true);
  expect(persisted()).toEqual({ theme: 'system' });
  expect(syncedSettings(settingsDocument.snapshot())).toEqual({ theme: 'system' });
});
