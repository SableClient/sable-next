import {
  hasCompleteOverride,
  overrideProblem,
  type PushOverride,
  trimmed,
} from '#lib/features/notifications/push-config.js';

import type { StoredThemes } from './custom-themes.svelte.js';
import type { Preferences } from './preferences.svelte.js';
import {
  type AppliedSettings,
  applySettings,
  prepareSettings,
  SETTINGS_ACCOUNT_DATA_TYPE,
} from './sync.js';

export interface SettingsImport extends AppliedSettings {
  push: PushOverride | null;
}

export function settingsFileJson(current: Preferences, themes: StoredThemes): string {
  const { content } = prepareSettings(current, themes);
  if (hasCompleteOverride(current)) {
    const { gateway, vapid, appId } = trimmed(current);
    Object.assign(content.settings, {
      pushGatewayUrl: gateway,
      pushVapidKey: vapid,
      pushAppId: appId,
    });
  }
  return JSON.stringify({ [SETTINGS_ACCOUNT_DATA_TYPE]: content }, null, 2);
}

export function settingsFileName(now = new Date()): string {
  return `sable-settings-${now.toISOString().slice(0, 10)}.json`;
}

export function parseSettingsFile(
  text: string,
  current: Preferences,
  themes: StoredThemes
): SettingsImport {
  const parsed: unknown = JSON.parse(text);
  const content: unknown =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)[SETTINGS_ACCOUNT_DATA_TYPE]
      : undefined;
  const kept = [...themes.themes, ...themes.tweaks].map((entry) => entry.id);
  const applied = applySettings(content, current, themes, kept);
  if (applied === null) throw new Error(`the file has no ${SETTINGS_ACCOUNT_DATA_TYPE} settings`);

  return {
    ...applied,
    push: readPush((content as { settings: Record<string, unknown> }).settings),
  };
}

function readPush(settings: Record<string, unknown>): PushOverride | null {
  const text = (key: keyof PushOverride): string => {
    const value = settings[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const push: PushOverride = {
    pushGatewayUrl: text('pushGatewayUrl'),
    pushVapidKey: text('pushVapidKey'),
    pushAppId: text('pushAppId'),
  };
  return hasCompleteOverride(push) && overrideProblem(push) === null ? push : null;
}
