import { readJson } from '#lib/platform/local-json.js';

import { syncBaseKey } from './account-sync.svelte.js';
import {
  accountThemesSettled,
  customThemes,
  selectThemeAccount,
  type StoredThemes,
} from './custom-themes.svelte.js';
import { DEFAULTS, type Preferences } from './definitions.js';
import {
  accountPreferencesSettled,
  lastSettingsAccount,
  preferences,
  selectPreferenceAccount,
} from './preferences.svelte.js';
import { applySettings, SETTINGS_ACCOUNT_DATA_TYPE } from './sync.js';

interface Seed {
  preferences: Partial<Preferences>;
  themes: StoredThemes;
}

function syncedSeed(accountId: string): Seed | undefined {
  const base = readJson(syncBaseKey(accountId, SETTINGS_ACCOUNT_DATA_TYPE), (value) => value, null);
  const applied = applySettings(base, DEFAULTS, customThemes, []);
  if (applied === null) return undefined;
  return {
    preferences: Object.fromEntries(applied.keys.map((key) => [key, applied.preferences[key]])),
    themes: applied.themes,
  };
}

let current = lastSettingsAccount();

export function selectSettingsAccount(accountId: string | null): void {
  // After an update the signed-out settings are the ones the first account was using.
  const inherits =
    accountId === null ||
    current === null ||
    !preferences.settingsSync ||
    (accountPreferencesSettled(accountId) && accountThemesSettled(accountId));
  const seed = inherits ? undefined : syncedSeed(accountId);
  current = accountId;
  selectPreferenceAccount(accountId, seed?.preferences);
  selectThemeAccount(accountId, seed?.themes);
}
