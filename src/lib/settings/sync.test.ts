import { describe, expect, it } from 'vitest';

import type { StoredThemes } from './custom-themes.svelte';
import { preferences } from './preferences.svelte';
import type { Preferences } from './preferences.svelte';
import { fingerprint } from './fingerprint';
import { applySettings, prepareSettings } from './sync';

const base: Preferences = { ...preferences };
const noThemes: StoredThemes = { themes: [], lightThemeId: null, darkThemeId: null };

function theme(id: string, css: string): StoredThemes['themes'][number] {
  return { id, name: id, kind: 'dark', css };
}

describe('prepareSettings', () => {
  it('uploads syncable preferences and withholds device-local ones', () => {
    const { content } = prepareSettings(
      { ...base, layout: 'compact', developerTools: true, desktopNotifications: true },
      noThemes
    );

    expect(content.settings.layout).toBe('compact');
    expect(content.settings).not.toHaveProperty('developerTools');
    expect(content.settings).not.toHaveProperty('desktopNotifications');
    expect(content.settings).not.toHaveProperty('settingsSync');
  });

  it('drops a custom theme that does not fit the budget', () => {
    const large = theme('large', 'a'.repeat(300 * 1024));
    const { content, excludedThemeIds } = prepareSettings(base, {
      themes: [theme('small', 'body{}'), large],
      lightThemeId: null,
      darkThemeId: 'large',
    });

    expect(excludedThemeIds).toEqual(['large']);
    expect(content.themes.themes.map((entry) => entry.id)).toEqual(['small']);
    expect(content.themes.darkThemeId).toBeNull();
  });
});

describe('applySettings', () => {
  it('takes remote preferences and keeps the device-local ones', () => {
    const local: Preferences = { ...base, layout: 'modern', developerTools: true };
    const { content } = prepareSettings(
      { ...base, layout: 'bubble', developerTools: false },
      noThemes
    );

    const applied = applySettings(content, local, noThemes, []);

    expect(applied?.preferences.layout).toBe('bubble');
    expect(applied?.preferences.developerTools).toBe(true);
  });

  it('ignores a value the preference does not accept', () => {
    const applied = applySettings(
      { v: 1, settings: { layout: 'holographic' }, themes: noThemes },
      base,
      noThemes,
      []
    );

    expect(applied?.preferences.layout).toBe(base.layout);
  });

  it('carries the pronoun preferences across devices', () => {
    const { content } = prepareSettings(
      { ...base, filterPronounsByLanguage: false, pronounPillLimit: 'all' },
      noThemes
    );

    expect(content.settings.filterPronounsByLanguage).toBe(false);
    expect(content.settings.pronounPillLimit).toBe('all');

    const applied = applySettings(content, base, noThemes, []);

    expect(applied?.preferences.filterPronounsByLanguage).toBe(false);
    expect(applied?.preferences.pronounPillLimit).toBe('all');
  });

  it('ignores a pill count outside the accepted set', () => {
    const applied = applySettings(
      { v: 1, settings: { pronounPillLimit: '12' }, themes: noThemes },
      base,
      noThemes,
      []
    );

    expect(applied?.preferences.pronounPillLimit).toBe(base.pronounPillLimit);
  });

  it('refuses content from another schema version', () => {
    expect(applySettings({ v: 2, settings: {} }, base, noThemes, [])).toBeNull();
    expect(applySettings(null, base, noThemes, [])).toBeNull();
  });

  it('keeps a local theme that was too large to upload', () => {
    const large = theme('large', 'a'.repeat(300 * 1024));
    const local: StoredThemes = { themes: [large], lightThemeId: null, darkThemeId: 'large' };
    const { content } = prepareSettings(base, {
      themes: [theme('remote', 'body{}')],
      lightThemeId: null,
      darkThemeId: null,
    });

    const applied = applySettings(content, base, local, ['large']);

    expect(applied?.themes.themes.map((entry) => entry.id)).toEqual(['remote', 'large']);
    expect(applied?.themes.darkThemeId).toBe('large');
  });
});

describe('fingerprint', () => {
  it('matches a payload whose keys arrived in another order', () => {
    const { content } = prepareSettings(base, noThemes);
    const reordered = {
      ...content,
      settings: Object.fromEntries(Object.entries(content.settings).reverse()),
    };

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(content));
    expect(fingerprint(reordered)).toBe(fingerprint(content));
  });
});
