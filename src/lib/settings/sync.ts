import { isCatalogReference, readThemes, type StoredThemes } from './custom-themes.svelte.js';
import { migrateSettings, SETTINGS_SCHEMA } from './migrations.js';
import { compressCss, decompressCss } from './theme-compression.js';
import { PREFERENCE_KEYS, sanitize } from './preferences.svelte.js';
import type { Preferences } from './preferences.svelte.js';

export const SETTINGS_ACCOUNT_DATA_TYPE = 'moe.sable.next.settings';
export const SETTINGS_SYNC_VERSION = 1;

const MAX_SYNCED_THEME_CSS_BYTES = 10 * 1024 * 1024;
export const SYNCED_THEME_LIMIT_MIB = MAX_SYNCED_THEME_CSS_BYTES / (1024 * 1024);

export const NON_SYNCABLE_KEYS = new Set<keyof Preferences>([
  'settingsSync',
  'syncDrafts',
  'enterForNewline',
  'reducedMotion',
  'pageZoom',
  'textScale',
  'roomBannerHeight',
  'searchIndexLimit',
  'searchUnmeteredOnly',
  'audioInputDevice',
  'audioOutputDevice',
  'videoInputDevice',
  'layout',
  'threadPresentation',
  'messageSpacing',
  'mediaAutoLoad',
  'callRingtoneVolume',
  'noiseSuppression',
  'echoCancellation',
  'autoGainControl',
  'voiceIsolation',
  'incomingVoiceIsolation',
  'systemNotifications',
  'notificationContent',
  'notificationEncryptedContent',
  'richPushPayloads',
  'notificationSounds',
  'notificationSoundVolume',
  'backgroundNotificationSounds',
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
  schema: number;
  settings: Partial<Preferences>;
  themes: Omit<StoredThemes, 'themes' | 'tweaks'> & {
    themes: Wire<StoredThemes['themes'][number]>[];
    tweaks: Wire<StoredThemes['tweaks'][number]>[];
  };
}

type Wire<T> = Omit<T, 'css'> & { css?: string; cssz?: string };

function toWire<T extends { css: string; source?: string }>(entry: T): Wire<T> {
  const { css, ...rest } = entry;
  return isCatalogReference(entry) ? { ...rest, css: '' } : { ...rest, cssz: compressCss(css) };
}

function fromWire(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return [];
    const { cssz, ...rest } = entry as Record<string, unknown>;
    if (typeof cssz !== 'string') return [rest];
    const css = decompressCss(cssz);
    return css === null ? [] : [{ ...rest, css }];
  });
}

function withLocalCss<T extends { id: string; css: string; source?: string }>(
  remote: T[],
  local: readonly T[]
): T[] {
  return remote.map((entry) => {
    if (entry.css !== '') return entry;
    const held = local.find((item) => item.id === entry.id && item.source === entry.source);
    return held ? { ...entry, css: held.css } : entry;
  });
}

export interface PreparedSettings {
  content: SettingsSyncContent;
  excludedThemeIds: string[];
}

export function prepareSettings(
  current: Preferences,
  themes: StoredThemes,
  include: (key: keyof Preferences) => boolean = () => true
): PreparedSettings {
  const settings: Partial<Preferences> = {};
  for (const key of PREFERENCE_KEYS) {
    if (!NON_SYNCABLE_KEYS.has(key) && include(key)) {
      (settings as Record<string, unknown>)[key] = current[key];
    }
  }

  const excludedThemeIds: string[] = [];
  let used = 0;
  const fits = (entry: { id: string; css: string; source?: string }): boolean => {
    if (isCatalogReference(entry)) return true;
    const bytes = compressCss(entry.css).length;
    if (used + bytes > MAX_SYNCED_THEME_CSS_BYTES) {
      excludedThemeIds.push(entry.id);
      return false;
    }
    used += bytes;
    return true;
  };

  const kept = themes.themes.filter(fits);
  const keptTweaks = themes.tweaks.filter(fits);

  const keptIds = new Set(kept.map((theme) => theme.id));
  const keptTweakIds = new Set(keptTweaks.map((tweak) => tweak.id));
  return {
    content: {
      v: SETTINGS_SYNC_VERSION,
      schema: SETTINGS_SCHEMA,
      settings,
      themes: {
        themes: kept.map(toWire),
        tweaks: keptTweaks.map(toWire),
        lightThemeId: keepId(themes.lightThemeId, keptIds),
        darkThemeId: keepId(themes.darkThemeId, keptIds),
        enabledTweakIds: themes.enabledTweakIds.filter((id) => keptTweakIds.has(id)),
      },
    },
    excludedThemeIds,
  };
}

export interface AppliedSettings {
  preferences: Preferences;
  keys: (keyof Preferences)[];
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

  const received = content.settings;
  if (received === null || typeof received !== 'object' || Array.isArray(received)) return null;

  const remote = migrateSettings(received as Record<string, unknown>, content.schema);
  const merged = sanitize(remote, current);
  for (const key of NON_SYNCABLE_KEYS) {
    (merged as unknown as Record<string, unknown>)[key] = current[key];
  }

  return {
    preferences: merged,
    keys: PREFERENCE_KEYS.filter((key) => key in remote && !NON_SYNCABLE_KEYS.has(key)),
    themes: mergeThemes(content.themes, currentThemes, excludedThemeIds),
  };
}

function unwire(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  const value = data as Record<string, unknown>;
  return { ...value, themes: fromWire(value.themes), tweaks: fromWire(value.tweaks) };
}

function keepId(id: string | null, kept: ReadonlySet<string>): string | null {
  return id !== null && kept.has(id) ? id : null;
}

function mergeThemes(
  data: unknown,
  current: StoredThemes,
  excludedThemeIds: readonly string[]
): StoredThemes {
  const remote = readThemes(unwire(data));
  if (remote === null) return current;

  const excluded = new Set(excludedThemeIds);
  const remoteIds = new Set(remote.themes.map((theme) => theme.id));
  const themes = [
    ...withLocalCss(remote.themes, current.themes),
    ...current.themes.filter((theme) => excluded.has(theme.id) && !remoteIds.has(theme.id)),
  ];
  const remoteTweakIds = new Set(remote.tweaks.map((tweak) => tweak.id));
  const tweaks = [
    ...withLocalCss(remote.tweaks, current.tweaks),
    ...current.tweaks.filter((tweak) => excluded.has(tweak.id) && !remoteTweakIds.has(tweak.id)),
  ];
  const held = new Set(themes.map((theme) => theme.id));
  const heldTweaks = new Set(tweaks.map((tweak) => tweak.id));

  return {
    themes,
    tweaks,
    lightThemeId: keepId(remote.lightThemeId ?? current.lightThemeId, held),
    darkThemeId: keepId(remote.darkThemeId ?? current.darkThemeId, held),
    enabledTweakIds: [
      ...remote.enabledTweakIds,
      ...current.enabledTweakIds.filter((id) => excluded.has(id) && !remoteTweakIds.has(id)),
    ].filter((id) => heldTweaks.has(id)),
  };
}
