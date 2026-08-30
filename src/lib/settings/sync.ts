import type { CustomTheme, StoredThemes } from './custom-themes.svelte.js';
import { PREFERENCE_KEYS, sanitize } from './preferences.svelte.js';
import type { Preferences } from './preferences.svelte.js';

export const SETTINGS_ACCOUNT_DATA_TYPE = 'moe.sable.next.settings';
export const SETTINGS_SYNC_VERSION = 1;

const MAX_SYNCED_THEME_CSS_BYTES = 256 * 1024;

export const NON_SYNCABLE_KEYS = new Set<keyof Preferences>([
  'settingsSync',
  'syncDrafts',
  'enterForNewline',
  'reducedMotion',
  'desktopNotifications',
  'pushGatewayUrl',
  'pushVapidKey',
  'pushAppId',
  'errorReporting',
  'sessionReplay',
  'telemetryAsked',
  'autoUpdateCheck',
  'closeToTray',
  'showSystemTrayIcon',
  'useCustomTitleBar',
  'developerTools',
]);

export interface SettingsSyncContent {
  v: number;
  settings: Partial<Preferences>;
  themes: StoredThemes;
}

export interface PreparedSettings {
  content: SettingsSyncContent;
  excludedThemeIds: string[];
}

export function prepareSettings(
  current: Preferences,
  themes: Pick<StoredThemes, 'themes' | 'lightThemeId' | 'darkThemeId'>
): PreparedSettings {
  const settings: Partial<Preferences> = {};
  for (const key of PREFERENCE_KEYS) {
    if (!NON_SYNCABLE_KEYS.has(key)) (settings as Record<string, unknown>)[key] = current[key];
  }

  const excludedThemeIds: string[] = [];
  let used = 0;
  const kept = themes.themes.filter((theme) => {
    const bytes = new TextEncoder().encode(theme.css).byteLength;
    if (used + bytes > MAX_SYNCED_THEME_CSS_BYTES) {
      excludedThemeIds.push(theme.id);
      return false;
    }
    used += bytes;
    return true;
  });

  const keptIds = new Set(kept.map((theme) => theme.id));
  return {
    content: {
      v: SETTINGS_SYNC_VERSION,
      settings,
      themes: {
        themes: kept,
        lightThemeId: keepId(themes.lightThemeId, keptIds),
        darkThemeId: keepId(themes.darkThemeId, keptIds),
      },
    },
    excludedThemeIds,
  };
}

export interface AppliedSettings {
  preferences: Preferences;
  themes: StoredThemes;
}

export function applySettings(
  data: unknown,
  current: Preferences,
  currentThemes: StoredThemes,
  excludedThemeIds: readonly string[]
): AppliedSettings | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const content = data as Record<string, unknown>;
  if (content.v !== SETTINGS_SYNC_VERSION) return null;

  const remote = content.settings;
  if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) return null;

  const merged = sanitize(remote as Record<string, unknown>, current);
  for (const key of NON_SYNCABLE_KEYS) {
    (merged as unknown as Record<string, unknown>)[key] = current[key];
  }

  return {
    preferences: merged,
    themes: mergeThemes(content.themes, currentThemes, excludedThemeIds),
  };
}

function keepId(id: string | null, kept: ReadonlySet<string>): string | null {
  return id !== null && kept.has(id) ? id : null;
}

function mergeThemes(
  data: unknown,
  current: StoredThemes,
  excludedThemeIds: readonly string[]
): StoredThemes {
  const remote = readThemes(data);
  if (remote === null) return current;

  const excluded = new Set(excludedThemeIds);
  const remoteIds = new Set(remote.themes.map((theme) => theme.id));
  const themes = [
    ...remote.themes,
    ...current.themes.filter((theme) => excluded.has(theme.id) && !remoteIds.has(theme.id)),
  ];
  const held = new Set(themes.map((theme) => theme.id));

  return {
    themes,
    lightThemeId: keepId(remote.lightThemeId ?? current.lightThemeId, held),
    darkThemeId: keepId(remote.darkThemeId ?? current.darkThemeId, held),
  };
}

function readThemes(data: unknown): StoredThemes | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Partial<StoredThemes>;
  if (!Array.isArray(value.themes)) return null;

  return {
    themes: value.themes.filter(isCustomTheme),
    lightThemeId: typeof value.lightThemeId === 'string' ? value.lightThemeId : null,
    darkThemeId: typeof value.darkThemeId === 'string' ? value.darkThemeId : null,
  };
}

function isCustomTheme(value: unknown): value is CustomTheme {
  if (value === null || typeof value !== 'object') return false;
  const theme = value as Partial<CustomTheme>;
  return (
    typeof theme.id === 'string' &&
    typeof theme.name === 'string' &&
    (theme.kind === 'light' || theme.kind === 'dark') &&
    typeof theme.css === 'string'
  );
}
