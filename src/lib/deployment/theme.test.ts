// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { applyCustomTheme, applyCustomTweaks, applyQuickCss } from '#lib/settings/theme.js';

import { loadDeploymentTheme, setDeploymentThemeKind } from './theme.js';

const THEME = '/* @sable-theme\nname: Corp\nkind: dark\n*/\n:root { --primary-main: #123456; }';

function respond(body: string, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 404, text: () => Promise.resolve(body) })
  );
}

const theme = (themeUrl: string | null) => ({ themeUrl, lightThemeUrl: null, darkThemeUrl: null });

const ids = (): string[] => [...document.head.querySelectorAll('style')].map((style) => style.id);

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  setDeploymentThemeKind('light');
  document.head.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('injects the parsed theme', async () => {
  respond(THEME);
  await loadDeploymentTheme(theme('/brand.sable.css'));
  expect(document.getElementById('sable-deployment-theme')?.textContent).toContain('#123456');
});

it('sits below user themes, tweaks and quick CSS whatever the load order', async () => {
  applyQuickCss('a{}');
  applyCustomTweaks(['b{}']);
  applyCustomTheme(THEME);
  respond(THEME);
  await loadDeploymentTheme(theme('/brand.sable.css'));
  expect(ids()).toEqual([
    'sable-deployment-theme',
    'sable-custom-theme',
    'sable-custom-tweaks',
    'sable-quick-css',
  ]);
});

it('stays below user styles applied afterwards', async () => {
  respond(THEME);
  await loadDeploymentTheme(theme('/brand.sable.css'));
  applyCustomTheme(THEME);
  expect(ids()).toEqual(['sable-deployment-theme', 'sable-custom-theme']);
});

it('clears the previous theme without a theme url', async () => {
  respond(THEME);
  await loadDeploymentTheme(theme('/previous.sable.css'));
  vi.mocked(fetch).mockClear();
  await loadDeploymentTheme(theme(null));
  expect(fetch).not.toHaveBeenCalled();
  expect(document.getElementById('sable-deployment-theme')).toBeNull();
});

it.each([
  [
    'a failed request',
    () => {
      respond('', false);
    },
  ],
  [
    'an unparseable file',
    () => {
      respond('body { color: red; }');
    },
  ],
  [
    'a network error',
    () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    },
  ],
])('logs and keeps the default theme on %s', async (_, setup) => {
  setup();
  await loadDeploymentTheme(theme('/brand.sable.css'));
  expect(document.getElementById('sable-deployment-theme')).toBeNull();
  expect(console.debug).toHaveBeenCalledWith(
    '[sable deployment] theme not applied',
    '/brand.sable.css',
    expect.anything()
  );
});

it('clears the previous theme immediately and discards a stale response', async () => {
  respond(THEME);
  await loadDeploymentTheme(theme('/previous.sable.css'));
  let finishOld: (response: { ok: boolean; text: () => Promise<string> }) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(THEME.replace('#123456', '#abcdef')),
      })
  );
  const pending = loadDeploymentTheme(theme('/old.sable.css'));
  expect(document.getElementById('sable-deployment-theme')).toBeNull();
  await loadDeploymentTheme(theme('/new.sable.css'));
  finishOld({ ok: true, text: () => Promise.resolve(THEME) });
  await pending;
  expect(document.getElementById('sable-deployment-theme')?.textContent).toContain('#abcdef');
});

it('discards a slow theme body after signing out', async () => {
  let finishBody: (body: string) => void = () => {};
  const body = new Promise<string>((resolve) => {
    finishBody = resolve;
  });
  const text = vi.fn(() => body);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text }));
  const pending = loadDeploymentTheme(theme('/old.sable.css'));
  await vi.waitFor(() => {
    expect(text).toHaveBeenCalled();
  });
  await loadDeploymentTheme(theme(null));
  finishBody(THEME);
  await pending;
  expect(document.getElementById('sable-deployment-theme')).toBeNull();
});

it('follows the light or dark mode, falling back to themeUrl', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(THEME.replace('#123456', url)) })
    )
  );
  const css = () => document.getElementById('sable-deployment-theme')?.textContent;
  await loadDeploymentTheme({
    themeUrl: '/base.sable.css',
    lightThemeUrl: null,
    darkThemeUrl: '/dark.sable.css',
  });
  expect(css()).toContain('/base.sable.css');
  setDeploymentThemeKind('dark');
  expect(css()).toContain('/dark.sable.css');
  expect(fetch).toHaveBeenCalledTimes(2);
});
