import { describe, expect, it } from 'vitest';

import type { StoredThemes } from './custom-themes.svelte';
import { preferences } from './preferences.svelte';
import type { Preferences } from './preferences.svelte';
import { parseSettingsFile, settingsFileJson } from './settings-file';
import {
  SETTINGS_ACCOUNT_DATA_TYPE,
  SETTINGS_SYNC_VERSION,
  type SettingsSyncContent,
} from './sync';

const base: Preferences = {
  ...preferences,
  pushGatewayUrl: '',
  pushVapidKey: '',
  pushAppId: '',
};

const noThemes: StoredThemes = {
  themes: [],
  tweaks: [],
  lightThemeId: null,
  darkThemeId: null,
  enabledTweakIds: [],
};

const gateway = {
  pushGatewayUrl: 'https://push.example.org/_matrix/push/v1/notify',
  pushVapidKey: 'BCnS4Sb',
  pushAppId: 'org.example.web',
};

function file(settings: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    [SETTINGS_ACCOUNT_DATA_TYPE]: { v: SETTINGS_SYNC_VERSION, settings, ...extra },
  });
}

function exportedContent(json: string): SettingsSyncContent {
  return (JSON.parse(json) as Record<string, SettingsSyncContent>)[SETTINGS_ACCOUNT_DATA_TYPE];
}

describe('settingsFileJson', () => {
  it('writes syncable preferences under the account data type', () => {
    const content = exportedContent(
      settingsFileJson({ ...base, dateFormat: 'ymd', developerTools: true }, noThemes)
    );

    expect(content.v).toBe(SETTINGS_SYNC_VERSION);
    expect(content.settings.dateFormat).toBe('ymd');
    expect(content.settings).not.toHaveProperty('developerTools');
    expect(content.settings).not.toHaveProperty('pushGatewayUrl');
    expect(content.themes).toEqual(noThemes);
  });

  it('includes a complete push override', () => {
    const content = exportedContent(settingsFileJson({ ...base, ...gateway }, noThemes));

    expect(content.settings).toMatchObject(gateway);
  });

  it('leaves out a partial push override', () => {
    const content = exportedContent(
      settingsFileJson({ ...base, pushGatewayUrl: gateway.pushGatewayUrl }, noThemes)
    );

    expect(content.settings).not.toHaveProperty('pushGatewayUrl');
  });
});

describe('parseSettingsFile', () => {
  it('round-trips an export', () => {
    const exported = settingsFileJson({ ...base, dateFormat: 'ymd', ...gateway }, noThemes);
    const imported = parseSettingsFile(exported, { ...base, dateFormat: 'dmy' }, noThemes);

    expect(imported.preferences.dateFormat).toBe('ymd');
    expect(imported.push).toEqual(gateway);
  });

  it('applies only the keys in the file and drops bad values', () => {
    const current: Preferences = { ...base, dateFormat: 'dmy', underlineLinks: true };
    const imported = parseSettingsFile(
      file({ underlineLinks: false, dateFormat: 'yesterday' }),
      current,
      noThemes
    );

    expect(imported.preferences).toEqual({ ...current, underlineLinks: false });
    expect(imported.push).toBeNull();
  });

  it('never takes a device-local key from the file', () => {
    const imported = parseSettingsFile(
      file({ developerTools: true, settingsSync: true, errorReporting: true }),
      { ...base, developerTools: false, settingsSync: false, errorReporting: false },
      noThemes
    );

    expect(imported.preferences.developerTools).toBe(false);
    expect(imported.preferences.settingsSync).toBe(false);
    expect(imported.preferences.errorReporting).toBe(false);
  });

  it('keeps push overrides out of the preferences and returns them separately', () => {
    const imported = parseSettingsFile(file(gateway), base, noThemes);

    expect(imported.preferences.pushGatewayUrl).toBe('');
    expect(imported.push).toEqual(gateway);
  });

  it.each([
    ['incomplete', { pushGatewayUrl: gateway.pushGatewayUrl }],
    ['not a gateway', { ...gateway, pushGatewayUrl: 'http://push.example.org/notify' }],
  ])('ignores a push override that is %s', (_, settings) => {
    expect(parseSettingsFile(file(settings), base, noThemes).push).toBeNull();
  });

  it('merges themes into the ones already installed', () => {
    const current: StoredThemes = {
      ...noThemes,
      themes: [{ id: 'mine', name: 'Mine', kind: 'dark', css: 'a{}' }],
      darkThemeId: 'mine',
    };
    const imported = parseSettingsFile(
      file(
        {},
        {
          themes: {
            themes: [{ id: 'club', name: 'Club', kind: 'light', css: 'b{}' }],
            tweaks: [],
            lightThemeId: 'club',
            darkThemeId: null,
            enabledTweakIds: [],
          },
        }
      ),
      base,
      current
    );

    expect(imported.themes.themes.map((theme) => theme.id)).toEqual(['club', 'mine']);
    expect(imported.themes.lightThemeId).toBe('club');
    expect(imported.themes.darkThemeId).toBe('mine');
  });

  it('keeps the installed themes when the file has none', () => {
    const current: StoredThemes = {
      ...noThemes,
      themes: [{ id: 'mine', name: 'Mine', kind: 'dark', css: 'a{}' }],
    };

    expect(parseSettingsFile(file({}), base, current).themes).toEqual(current);
  });

  it.each([
    ['another event type', JSON.stringify({ 'moe.sable.next.workspace': {} })],
    ['another version', JSON.stringify({ [SETTINGS_ACCOUNT_DATA_TYPE]: { v: 99, settings: {} } })],
    ['no settings', JSON.stringify({ [SETTINGS_ACCOUNT_DATA_TYPE]: { v: SETTINGS_SYNC_VERSION } })],
    ['not an object', 'null'],
  ])('rejects %s', (_, text) => {
    expect(() => parseSettingsFile(text, base, noThemes)).toThrow();
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseSettingsFile('not json', base, noThemes)).toThrow();
  });
});
