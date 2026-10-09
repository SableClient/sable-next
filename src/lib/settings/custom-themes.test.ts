// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import {
  customThemes,
  hydrateCatalogThemes,
  installCustomTheme,
  installCustomTweak,
  removeCustomTheme,
  removeCustomTweak,
  replaceCustomThemes,
  updateCatalogThemes,
} from './custom-themes.svelte.js';

afterEach(() => {
  vi.unstubAllGlobals();
  replaceCustomThemes({
    themes: [],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  });
  localStorage.clear();
});

test('removing the selected theme falls back to the built-in one', () => {
  installCustomTheme({ id: 'night', name: 'Night', kind: 'dark', css: '/* @sable-theme */' });
  expect(customThemes.darkThemeId).toBe('night');

  removeCustomTheme('night');

  expect(customThemes.themes).toEqual([]);
  expect(customThemes.darkThemeId).toBeNull();
  expect(localStorage.getItem('sable-custom-themes')).not.toContain('night');
});

test('installing a theme without activation preserves the current selection', () => {
  installCustomTheme(
    { id: 'night', name: 'Night', kind: 'dark', css: '/* @sable-theme */' },
    false
  );

  expect(customThemes.themes.map((theme) => theme.id)).toEqual(['night']);
  expect(customThemes.darkThemeId).toBeNull();
});

test('removing a tweak also disables it', () => {
  installCustomTweak({ id: 'round', name: 'Round', css: '/* @sable-tweak */' });
  expect(customThemes.enabledTweakIds).toEqual(['round']);

  removeCustomTweak('round');

  expect(customThemes.tweaks).toEqual([]);
  expect(customThemes.enabledTweakIds).toEqual([]);
});

const CATALOG_THEME = 'https://git.sable.moe/SableClient/themes/raw/branch/main/themes/night.css';

function holdEmptyCatalogTheme(): void {
  replaceCustomThemes({
    themes: [{ id: 'night', name: 'Night', kind: 'dark', css: '', source: CATALOG_THEME }],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: 'night',
    enabledTweakIds: [],
  });
}

test('a catalog theme synced without css is refetched and persisted', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response('/* @sable-theme */')));
  vi.stubGlobal('fetch', fetchMock);
  holdEmptyCatalogTheme();

  await Promise.all([hydrateCatalogThemes(), hydrateCatalogThemes()]);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(customThemes.themes[0]?.css).toBe('/* @sable-theme */');
  expect(localStorage.getItem('sable-custom-themes')).toContain('@sable-theme');
});

test('a failed catalog fetch is retried by the next hydration', async () => {
  const fetchMock = vi
    .fn<() => Promise<Response>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response('/* @sable-theme */'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  holdEmptyCatalogTheme();

  await hydrateCatalogThemes();
  expect(customThemes.themes[0]?.css).toBe('');

  await hydrateCatalogThemes();
  expect(customThemes.themes[0]?.css).toBe('/* @sable-theme */');
});

test('an installed catalog theme is refreshed from the catalog and persisted', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response('/* @sable-theme new */')));
  vi.stubGlobal('fetch', fetchMock);
  replaceCustomThemes({
    themes: [
      {
        id: 'night',
        name: 'Night',
        kind: 'dark',
        css: '/* @sable-theme old */',
        source: CATALOG_THEME,
      },
    ],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: 'night',
    enabledTweakIds: [],
  });

  await updateCatalogThemes();

  expect(fetchMock).toHaveBeenCalledWith(
    CATALOG_THEME,
    expect.objectContaining({ cache: 'no-cache' })
  );
  expect(customThemes.themes[0]?.css).toBe('/* @sable-theme new */');
  expect(localStorage.getItem('sable-custom-themes')).toContain('new');

  await updateCatalogThemes();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a failed refresh keeps the installed css and is retried at once', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 7 * 60 * 60_000);
  const fetchMock = vi
    .fn<() => Promise<Response>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response('/* @sable-theme new */'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  replaceCustomThemes({
    themes: [],
    tweaks: [
      { id: 'round', name: 'Round', css: '/* tweak old */', source: CATALOG_THEME },
      { id: 'mine', name: 'Mine', css: '/* local */' },
    ],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  });

  try {
    await updateCatalogThemes();
    expect(customThemes.tweaks[0]?.css).toBe('/* tweak old */');

    await updateCatalogThemes();
    expect(customThemes.tweaks[0]?.css).toBe('/* @sable-theme new */');
    expect(customThemes.tweaks[1]?.css).toBe('/* local */');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
