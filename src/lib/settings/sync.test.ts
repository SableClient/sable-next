import { describe, expect, it } from 'vitest';

import type { StoredThemes } from './custom-themes.svelte';
import { preferences } from './preferences.svelte';
import type { Preferences } from './definitions';
import { fingerprint } from './fingerprint';
import { applySettings, mergeSettings, prepareSettings } from './sync';

const base: Preferences = { ...preferences };

function stored(partial: Partial<StoredThemes> = {}): StoredThemes {
  return {
    themes: [],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
    ...partial,
  };
}

const noThemes: StoredThemes = stored();

let noise: string | undefined;

function oversized(): string {
  if (noise === undefined) {
    const bytes = new Uint8Array(12 * 1024 * 1024);
    let seed = 1;
    for (let i = 0; i < bytes.length; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      bytes[i] = 33 + ((seed >>> 16) % 64);
    }
    noise = new TextDecoder().decode(bytes);
  }
  return noise;
}

function theme(id: string, css: string): StoredThemes['themes'][number] {
  return { id, name: id, kind: 'dark', css };
}

function tweak(id: string, css: string): StoredThemes['tweaks'][number] {
  return { id, name: id, css };
}

describe('prepareSettings', () => {
  it('uploads syncable preferences and withholds device-local ones', () => {
    const { content } = prepareSettings(
      { ...base, dateFormat: 'ymd', developerTools: true, systemNotifications: true },
      noThemes
    );

    expect(content.settings.dateFormat).toBe('ymd');
    expect(content.settings).not.toHaveProperty('developerTools');
    expect(content.settings).not.toHaveProperty('systemNotifications');
    expect(content.settings).not.toHaveProperty('settingsSync');
    expect(content.settings).not.toHaveProperty('searchUnmeteredOnly');
    expect(content.settings).not.toHaveProperty('searchSharing');
    expect(content.settings).not.toHaveProperty('threadPresentation');
  });

  it('drops a custom theme that does not fit the budget', { timeout: 30_000 }, () => {
    const large = theme('large', oversized());
    const { content, excludedThemeIds } = prepareSettings(
      base,
      stored({ themes: [theme('small', 'body{}'), large], darkThemeId: 'large' })
    );

    expect(excludedThemeIds).toEqual(['large']);
    expect(content.themes.themes.map((entry) => entry.id)).toEqual(['small']);
    expect(content.themes.darkThemeId).toBeNull();
  });

  it('fits more css than the budget once it is compressed', () => {
    const css = '.rule { color: red; margin: 0 }\n'.repeat(28 * 1024);
    const themes = Array.from({ length: 14 }, (_, index) =>
      theme(`t${String(index)}`, css + index)
    );

    const { content, excludedThemeIds } = prepareSettings(base, stored({ themes }));

    expect(excludedThemeIds).toEqual([]);
    expect(applySettings(content, base, noThemes, [])?.themes.themes.map((t) => t.css)).toEqual(
      themes.map((t) => t.css)
    );
  });

  it('drops an entry that inflates past the file limit', () => {
    const { content } = prepareSettings(base, stored({ themes: [theme('bomb', 'x'.repeat(2e6))] }));

    expect(content.themes.themes).toHaveLength(1);
    expect(applySettings(content, base, noThemes, [])?.themes.themes).toEqual([]);
  });

  it('uploads tweaks with the ids that are enabled', () => {
    const { content } = prepareSettings(
      base,
      stored({ tweaks: [tweak('crt', 'body{}')], enabledTweakIds: ['crt', 'gone'] })
    );

    expect(content.themes.tweaks.map((entry) => entry.id)).toEqual(['crt']);
    expect(content.themes.enabledTweakIds).toEqual(['crt']);
  });
});

describe('applySettings', () => {
  it('keeps device notification preferences but takes the reading ones', () => {
    const local: Preferences = {
      ...base,
      notificationSounds: true,
      notificationContent: false,
      searchUnmeteredOnly: true,
      notifyOnce: true,
    };
    const remote = {
      v: 1,
      settings: {
        notificationSounds: false,
        notificationContent: true,
        notifyOnce: false,
        searchUnmeteredOnly: false,
      },
      themes: noThemes,
    };

    const applied = applySettings(remote, local, noThemes, []);

    expect(applied?.preferences.notificationSounds).toBe(true);
    expect(applied?.preferences.notificationContent).toBe(false);
    expect(applied?.preferences.searchUnmeteredOnly).toBe(true);
    expect(applied?.preferences.notifyOnce).toBe(false);
  });

  it('takes remote preferences and keeps the device-local ones', () => {
    const local: Preferences = { ...base, dateFormat: 'dmy', developerTools: true };
    const { content } = prepareSettings(
      { ...base, dateFormat: 'ymd', developerTools: false },
      noThemes
    );

    const applied = applySettings(content, local, noThemes, []);

    expect(applied?.preferences.dateFormat).toBe('ymd');
    expect(applied?.preferences.developerTools).toBe(true);
  });

  it('keeps this device’s page size and media devices over an older upload', () => {
    const local: Preferences = { ...base, pageZoom: 1.25, audioInputDevice: 'usb-mic' };
    const applied = applySettings(
      {
        v: 1,
        settings: { pageZoom: 0.75, audioInputDevice: 'webcam-mic' },
        themes: noThemes,
      },
      local,
      noThemes,
      []
    );

    expect(applied?.preferences.pageZoom).toBe(1.25);
    expect(applied?.preferences.audioInputDevice).toBe('usb-mic');
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

  it('carries the profile selection scope across devices', () => {
    const { content } = prepareSettings({ ...base, personaSelectionScope: 'room' }, noThemes);

    expect(content.settings.personaSelectionScope).toBe('room');

    const applied = applySettings(content, base, noThemes, []);

    expect(applied?.preferences.personaSelectionScope).toBe('room');
  });

  it('ignores a profile selection scope outside the accepted set', () => {
    const applied = applySettings(
      { v: 1, settings: { personaSelectionScope: 'everywhere' }, themes: noThemes },
      base,
      noThemes,
      []
    );

    expect(applied?.preferences.personaSelectionScope).toBe(base.personaSelectionScope);
  });

  it('refuses content from another schema version', () => {
    expect(applySettings({ v: 2, settings: {} }, base, noThemes, [])).toBeNull();
    expect(applySettings(null, base, noThemes, [])).toBeNull();
  });

  it('applies remote default themes while keeping installed custom themes', () => {
    const themes = [
      { ...theme('light', 'body{}'), kind: 'light' as const },
      theme('dark', 'body{}'),
    ];
    const local = stored({ themes, lightThemeId: 'light', darkThemeId: 'dark' });
    const { content } = prepareSettings(base, stored({ themes }));

    const applied = applySettings(content, base, local, []);

    expect(applied?.themes.themes).toEqual(themes);
    expect(applied?.themes.lightThemeId).toBeNull();
    expect(applied?.themes.darkThemeId).toBeNull();
  });

  it.each(['lightThemeId', 'darkThemeId'] as const)(
    'keeps %s selected when its local theme was too large to upload',
    (key) => {
      const large = theme('large', oversized());
      const local: StoredThemes = stored({ themes: [large], [key]: 'large' });
      const { content } = prepareSettings(base, stored({ themes: [theme('remote', 'body{}')] }));

      const applied = applySettings(content, base, local, ['large']);

      expect(applied?.themes.themes.map((entry) => entry.id)).toEqual(['remote', 'large']);
      expect(applied?.themes[key]).toBe('large');
    }
  );

  describe('catalog themes', () => {
    const source = 'https://git.sable.moe/SableClient/themes/raw/branch/main/dark/night.sable.css';
    const catalog = { ...theme('night', oversized()), source };

    it('uploads a reference without css and outside the budget', () => {
      const { content, excludedThemeIds } = prepareSettings(
        base,
        stored({ themes: [catalog, theme('mine', 'body{}')], darkThemeId: 'night' })
      );

      expect(excludedThemeIds).toEqual([]);
      expect(content.themes.themes[0]).toEqual({ ...catalog, css: '' });
      expect(content.themes.themes[1].css).toBeUndefined();
      expect(applySettings(content, base, noThemes, [])?.themes.themes[1].css).toBe('body{}');
      expect(content.themes.darkThemeId).toBe('night');
    });

    it('adopts a reference as an empty entry to hydrate, keeping local css when it has it', () => {
      const { content } = prepareSettings(base, stored({ themes: [catalog] }));

      const fresh = applySettings(content, base, noThemes, []);
      const held = applySettings(content, base, stored({ themes: [catalog] }), []);

      expect(fresh?.themes.themes[0].css).toBe('');
      expect(held?.themes.themes[0].css).toBe(catalog.css);
    });

    it('does not treat a source outside the catalog as a reference', () => {
      const forged = {
        ...theme('evil', oversized()),
        source: 'https://example.com/x.css',
      };
      const { content, excludedThemeIds } = prepareSettings(base, stored({ themes: [forged] }));

      expect(excludedThemeIds).toEqual(['evil']);
      expect(content.themes.themes).toEqual([]);
      expect(
        applySettings(
          { v: 1, settings: {}, themes: { themes: [{ ...forged, css: undefined }] } },
          base,
          noThemes,
          []
        )?.themes.themes
      ).toEqual([]);
    });
  });

  it('adopts remote tweaks and the ids they enable', () => {
    const { content } = prepareSettings(
      base,
      stored({ tweaks: [tweak('crt', 'body{}')], enabledTweakIds: ['crt'] })
    );

    const applied = applySettings(content, base, noThemes, []);

    expect(applied?.themes.tweaks.map((entry) => entry.id)).toEqual(['crt']);
    expect(applied?.themes.enabledTweakIds).toEqual(['crt']);
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

describe('mergeSettings', () => {
  const content = (partial: Partial<StoredThemes>, settings: Record<string, unknown> = {}) => ({
    ...prepareSettings(base, stored(partial)).content,
    settings,
  });

  it('keeps a tweak added on each device', () => {
    const origin = content({ tweaks: [tweak('shared', 'a{}')] });
    const mine = content({ tweaks: [tweak('shared', 'a{}'), tweak('mine', 'b{}')] });
    const theirs = content({ tweaks: [tweak('shared', 'a{}'), tweak('theirs', 'c{}')] });

    const merged = mergeSettings(origin, mine, theirs) as typeof origin;

    expect(merged.themes.tweaks.map((entry) => entry.id)).toEqual(['shared', 'theirs', 'mine']);
  });

  it('applies a removal made on one device and an edit made on the other', () => {
    const origin = content({ tweaks: [tweak('gone', 'a{}'), tweak('kept', 'b{}')] });
    const mine = content({ tweaks: [tweak('kept', 'b{}')] });
    const theirs = content({ tweaks: [tweak('gone', 'a{}'), tweak('kept', 'c{}')] });

    const merged = mergeSettings(origin, mine, theirs) as typeof origin;

    expect(merged.themes.tweaks.map((entry) => entry.id)).toEqual(['kept']);
    expect(merged.themes.tweaks[0]).toEqual(theirs.themes.tweaks[1]);
  });

  it('merges which tweaks are enabled and drops ones that no longer exist', () => {
    const all = [tweak('a', 'a{}'), tweak('b', 'b{}'), tweak('c', 'c{}')];
    const origin = content({ tweaks: all, enabledTweakIds: ['a'] });
    const mine = content({ tweaks: all, enabledTweakIds: ['a', 'b'] });
    const theirs = content({ tweaks: all.slice(0, 2), enabledTweakIds: ['a', 'c'] });

    const merged = mergeSettings(origin, mine, theirs) as typeof origin;

    expect(merged.themes.enabledTweakIds).toEqual(['a', 'b']);
  });

  it('prefers this device for a setting changed on both and the other for the rest', () => {
    const origin = content({}, { dateFormat: 'dmy', hour24: false, layout: 'a' });
    const mine = content({}, { dateFormat: 'ymd', hour24: false, layout: 'a' });
    const theirs = content({}, { dateFormat: 'mdy', hour24: true, layout: 'a' });

    const merged = mergeSettings(origin, mine, theirs) as typeof origin;

    expect(merged.settings).toEqual({ dateFormat: 'ymd', hour24: true, layout: 'a' });
  });

  it('declines to merge documents of different schemas', () => {
    const origin = content({});
    expect(mergeSettings(origin, origin, { ...origin, schema: origin.schema + 1 })).toBeNull();
    expect(mergeSettings(origin, origin, { ...origin, v: 99 })).toBeNull();
  });
});
