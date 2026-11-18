// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { SETTINGS_ACCOUNT_DATA_TYPE } from './sync.js';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function load() {
  const settings = await import('./preferences.svelte.js');
  const themes = await import('./custom-themes.svelte.js');
  const { selectSettingsAccount } = await import('./account-settings.js');
  const { syncBaseKey } = await import('./account-sync.svelte.js');
  const { settingsDocument } = await import('./sync-documents.js');
  return { settings, themes, selectSettingsAccount, syncBaseKey, settingsDocument };
}

const night = { id: 'night', name: 'Night', kind: 'dark' as const, css: 'body {}' };

test('each account keeps its own themes across a switch and a restart', async () => {
  const { themes, selectSettingsAccount } = await load();
  selectSettingsAccount('a');
  selectSettingsAccount('b');
  themes.installCustomTheme(night);

  selectSettingsAccount('a');
  expect(themes.customThemes.themes).toEqual([]);
  expect(themes.customThemes.darkThemeId).toBeNull();

  selectSettingsAccount('b');
  vi.resetModules();
  const restored = await load();
  expect(restored.themes.customThemes.themes).toEqual([night]);
  restored.selectSettingsAccount('a');
  expect(restored.themes.customThemes.themes).toEqual([]);
});

test('the first account after an update keeps the settings that were in use', async () => {
  localStorage.setItem('sable-preferences', JSON.stringify({ theme: 'dark' }));
  localStorage.setItem(
    'sable-custom-themes',
    JSON.stringify({ themes: [night], tweaks: [], darkThemeId: 'night', enabledTweakIds: [] })
  );
  const { settings, themes, selectSettingsAccount } = await load();

  selectSettingsAccount('a');

  expect(settings.preferences.theme).toBe('dark');
  expect(themes.customThemes.darkThemeId).toBe('night');
});

test('an account added later starts from the signed-out settings, not the account in use', async () => {
  localStorage.setItem('sable-preferences', JSON.stringify({ theme: 'dark' }));
  const { settings, themes, selectSettingsAccount } = await load();
  selectSettingsAccount('a');
  settings.setPreference('theme', 'light');
  themes.installCustomTheme(night);

  selectSettingsAccount('b');

  expect(settings.preferences.theme).toBe('dark');
  expect(themes.customThemes.themes).toEqual([]);
});

test('an account added later does not take the presence status the first account inherited', async () => {
  localStorage.setItem('sable-preferences', JSON.stringify({ presenceStatusMessage: 'Away' }));
  const { settings, selectSettingsAccount } = await load();

  selectSettingsAccount('a');
  expect(settings.preferences.presenceStatusMessage).toBe('Away');

  selectSettingsAccount('b');
  expect(settings.preferences.presenceStatusMessage).toBe('');
});

test('an account not yet stored here starts from what it last synced', async () => {
  const { settings, themes, selectSettingsAccount, syncBaseKey, settingsDocument } = await load();
  selectSettingsAccount('b');
  settings.setPreference('settingsSync', true);
  settings.setPreference('theme', 'light');
  localStorage.setItem(
    syncBaseKey('b', SETTINGS_ACCOUNT_DATA_TYPE),
    JSON.stringify(settingsDocument.snapshot().content)
  );

  selectSettingsAccount('a');
  settings.setPreference('theme', 'dark');
  themes.installCustomTheme(night);
  const stored = JSON.parse(localStorage.getItem('sable-account-preferences') ?? '{}') as object;
  localStorage.setItem('sable-account-preferences', JSON.stringify({ ...stored, b: undefined }));
  localStorage.removeItem('sable-custom-themes:b');

  selectSettingsAccount('b');

  expect(settings.preferences.theme).toBe('light');
  expect(themes.customThemes.themes).toEqual([]);
});
