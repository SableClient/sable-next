// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import { applyTheme } from '#lib/settings/theme.js';
import { systemDark } from './system-theme.js';

const query = vi.hoisted(() => {
  const query = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => query);
  return query;
});

afterEach(() => {
  delete window.__sableAndroidSystemTheme;
  query.matches = false;
});

function track(): string[] {
  const seen: string[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      applyTheme('system', systemDark.current);
      seen.push(document.documentElement.dataset.theme ?? '');
    });
  });
  onTestFinished(stop);
  flushSync();
  return seen;
}

function webTheme(dark: boolean): void {
  query.matches = dark;
  query.dispatchEvent(new Event('change'));
  flushSync();
}

test('Android ignores oscillating WebView theme queries', () => {
  window.__sableAndroidSystemTheme = { isDarkMode: () => true };
  const seen = track();

  for (const dark of [true, false, true, false]) webTheme(dark);

  expect(seen).toEqual(['dark']);
  expect(document.documentElement.style.colorScheme).toBe('dark');
});

test('Android follows native configuration changes in both directions', () => {
  let dark = false;
  window.__sableAndroidSystemTheme = { isDarkMode: () => dark };
  const seen = track();

  for (const next of [true, false]) {
    dark = next;
    window.dispatchEvent(new Event('sable:system-theme-changed'));
    flushSync();
  }

  expect(seen).toEqual(['light', 'dark', 'light']);
});

test('uses the media query without the Android bridge', () => {
  const seen = track();
  webTheme(true);
  webTheme(false);

  expect(seen).toEqual(['light', 'dark', 'light']);
});
