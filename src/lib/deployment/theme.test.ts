// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { applyCustomTheme, applyCustomTweaks, applyQuickCss } from '#lib/settings/theme.js';

import {
  hasDeploymentTheme,
  loadDeploymentTheme,
  loadLoginThemeColors,
  setLoginThemePreview,
  setDeploymentThemeEnabled,
  setDeploymentThemeKind,
} from './theme.svelte.js';

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
  setLoginThemePreview('');
  setDeploymentThemeKind('light');
  setDeploymentThemeEnabled(true);
  document.head.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('injects the parsed theme', async () => {
  respond(THEME);
  await loadDeploymentTheme(theme('/brand.sable.css'));
  expect(document.getElementById('sable-deployment-theme')?.textContent).toContain('#123456');
});

async function previewed(css: string): Promise<string> {
  respond(`/* @sable-theme */${css}`);
  return loadLoginThemeColors('/brand.sable.css', new AbortController().signal);
}

it('previews theme colors without applying stylesheet rules to login controls', async () => {
  const css = await previewed(`
    body { --sable-bg-container: #08040d; --sable-radius: 0px; }
    :root, body { --sec-main: #fde926; --font-family: monospace; }
    @media all { :root { --primary-main: #a057ff; } }
    @media not all { :root { --crit-main: #ff0000; } }
    input { --bg-on-container: red; display: none; }
  `);

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const [rule] = Array.from(sheet.cssRules) as CSSStyleRule[];
  expect(sheet.cssRules).toHaveLength(1);
  expect(rule.selectorText).toBe('body');
  expect(Array.from(rule.style)).toEqual([
    '--bg-container',
    '--radius',
    '--sec-main',
    '--primary-main',
  ]);
  expect(rule.style.getPropertyValue('--bg-container')).toBe('#08040d');
});

it('shows the login preview over the account theme until it is cleared', async () => {
  respond(THEME);
  await loadDeploymentTheme(theme('/brand.sable.css'));
  const applied = (): string | null | undefined =>
    document.getElementById('sable-deployment-theme')?.textContent;

  setLoginThemePreview('body { --primary-main: #a057ff; }');
  expect(applied()).toBe('body { --primary-main: #a057ff; }');

  setLoginThemePreview('');
  expect(applied()).toContain('#123456');
});

it('previews nothing when a palette color cannot be used', async () => {
  const css = await previewed(
    'body { --bg-container: #08040d; --bg-on-container: var(--brand-text); }'
  );

  expect(css).toBe('');
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

it('is left out while the user has turned it off, and comes back when turned on', async () => {
  respond(THEME);
  setDeploymentThemeEnabled(false);
  await loadDeploymentTheme(theme('/brand.sable.css'));
  expect(document.getElementById('sable-deployment-theme')).toBeNull();

  setDeploymentThemeEnabled(true);
  expect(document.getElementById('sable-deployment-theme')?.textContent).toContain('#123456');

  setDeploymentThemeEnabled(false);
  expect(document.getElementById('sable-deployment-theme')).toBeNull();
});

it('says whether the deployment names a theme', async () => {
  respond(THEME);
  await loadDeploymentTheme(theme(null));
  expect(hasDeploymentTheme()).toBe(false);

  await loadDeploymentTheme({
    themeUrl: null,
    lightThemeUrl: null,
    darkThemeUrl: '/dark.sable.css',
  });
  expect(hasDeploymentTheme()).toBe(true);
});
