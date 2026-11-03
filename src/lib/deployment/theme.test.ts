// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { applyCustomTheme, applyCustomTweaks, applyQuickCss } from '#lib/settings/theme.js';

import { loadDeploymentTheme } from './theme.js';

const THEME = '/* @sable-theme\nname: Corp\nkind: dark\n*/\n:root { --primary-main: #123456; }';

function respond(body: string, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 404, text: () => Promise.resolve(body) })
  );
}

const ids = (): string[] => [...document.head.querySelectorAll('style')].map((style) => style.id);

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  document.head.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('injects the parsed theme', async () => {
  respond(THEME);
  await loadDeploymentTheme('/brand.sable.css');
  expect(document.getElementById('sable-deployment-theme')?.textContent).toContain('#123456');
});

it('sits below user themes, tweaks and quick CSS whatever the load order', async () => {
  applyQuickCss('a{}');
  applyCustomTweaks(['b{}']);
  applyCustomTheme(THEME);
  respond(THEME);
  await loadDeploymentTheme('/brand.sable.css');
  expect(ids()).toEqual([
    'sable-deployment-theme',
    'sable-custom-theme',
    'sable-custom-tweaks',
    'sable-quick-css',
  ]);
});

it('stays below user styles applied afterwards', async () => {
  respond(THEME);
  await loadDeploymentTheme('/brand.sable.css');
  applyCustomTheme(THEME);
  expect(ids()).toEqual(['sable-deployment-theme', 'sable-custom-theme']);
});

it('does nothing without a theme url', async () => {
  respond(THEME);
  await loadDeploymentTheme(null);
  expect(fetch).not.toHaveBeenCalled();
  expect(ids()).toEqual([]);
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
  await loadDeploymentTheme('/brand.sable.css');
  expect(ids()).toEqual([]);
  expect(console.debug).toHaveBeenCalledWith(
    '[sable deployment] theme not applied',
    '/brand.sable.css',
    expect.anything()
  );
});
