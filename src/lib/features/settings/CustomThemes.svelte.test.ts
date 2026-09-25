// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/settings/appearance' }, params: {}, state: history.state },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));

import {
  customThemes,
  replaceCustomThemes,
  themePreview,
} from '#lib/settings/custom-themes.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import CustomThemes from './CustomThemes.svelte';
import { CATALOG_URL } from './theme-catalog';

const FILES = 'https://raw.githubusercontent.com/SableClient/themes/main/';
const NIGHT_URL = `${FILES}themes/night.sable.css`;
const NIGHT = `/*
@sable-theme
name: Night
author: ana
kind: dark
*/
.x { --sable-bg-container: #101018; }`;

const DAWN_URL = `${FILES}themes/dawn.sable.css`;
const DAWN = `/*
@sable-theme
name: Dawn
kind: light
*/
.x { --sable-bg-container: #fdf6e3; }`;

const fetched: string[] = [];

function respond(url: string): Response {
  fetched.push(url);
  if (url === CATALOG_URL) {
    return Response.json({
      themes: [
        {
          basename: 'night',
          previewUrl: `${FILES}themes/night.preview.sable.css`,
          fullUrl: NIGHT_URL,
        },
        { basename: 'dawn', previewUrl: null, fullUrl: DAWN_URL },
        { basename: 'elsewhere', previewUrl: null, fullUrl: 'https://evil.example/x.sable.css' },
      ],
      tweaks: [],
    });
  }
  return new Response(url === DAWN_URL ? DAWN : NIGHT);
}

function stubCatalog(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(respond(url)))
  );
}

async function openCatalog(): Promise<void> {
  button('Browse themes')?.click();
  await vi.waitFor(() => {
    expect(installButtons()).toHaveLength(2);
  });
}

function installButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (node) => node.textContent.trim() === 'Install & use'
  );
}

function tile(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.tile-hit')].find((node) =>
    node.textContent.includes(name)
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  replaceCustomThemes({
    themes: [],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  });
  for (const toast of toasts.items) toasts.dismiss(toast.id);
  fetched.length = 0;
  history.state.overlay = undefined;
  localStorage.clear();
});

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent.trim() === label
  );
}

test('offers the built-in theme in both slots, chosen by default', async () => {
  const instance = mount(CustomThemes, { target: document.body });

  const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(radios.map((radio) => radio.textContent.trim())).toEqual(['Sable', 'Sable']);
  expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'true')).toBe(true);
  await unmount(instance);
});

test('installs a catalogue theme into its slot and undoes it', async () => {
  stubCatalog();
  const instance = mount(CustomThemes, { target: document.body });

  await openCatalog();
  expect(document.body.textContent).not.toContain('elsewhere');
  expect(fetched.some((url) => url.includes('evil.example'))).toBe(false);

  tile('Night')
    ?.closest('.tile')
    ?.querySelector<HTMLButtonElement>('.tile-actions button')
    ?.click();
  await vi.waitFor(() => {
    expect(customThemes.themes.map((theme) => theme.source)).toEqual([NIGHT_URL]);
  });
  expect(customThemes.darkThemeId).toBe(customThemes.themes[0]?.id);
  flushSync();
  expect(button('In use')).toBeUndefined();

  const toast = toasts.items.find((item) => item.message === 'Night set for dark mode');
  expect(toast?.action?.label).toBe('Undo');
  toast?.action?.run();
  expect(customThemes.themes).toEqual([]);
  expect(customThemes.darkThemeId).toBeNull();
  await unmount(instance);
});

test('tapping a card previews it without installing, and Keep installs it', async () => {
  stubCatalog();
  const instance = mount(CustomThemes, { target: document.body });
  await openCatalog();

  tile('Night')?.click();
  await vi.waitFor(() => {
    expect(themePreview.current?.name).toBe('Night');
  });
  expect(customThemes.themes).toEqual([]);

  flushSync();
  button('Keep theme')?.click();
  expect(themePreview.current).toBeNull();
  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night']);

  tile('Dawn')?.click();
  await vi.waitFor(() => {
    expect(themePreview.current?.name).toBe('Dawn');
  });
  document.querySelector<HTMLButtonElement>('[aria-label="Close catalogue"]')?.click();
  flushSync();
  expect(themePreview.current).toBeNull();
  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night']);
  await unmount(instance);
});

test('undo of back-to-back installs reverts only those installs', async () => {
  replaceCustomThemes({
    themes: [{ id: 'mine', name: 'Mine', kind: 'dark', css: '/* @sable-theme */' }],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: 'mine',
    enabledTweakIds: [],
  });
  stubCatalog();
  const instance = mount(CustomThemes, { target: document.body });
  await openCatalog();

  for (const name of ['Night', 'Dawn']) {
    tile(name)?.closest('.tile')?.querySelector<HTMLButtonElement>('.tile-actions button')?.click();
    await vi.waitFor(() => {
      expect(customThemes.themes.some((theme) => theme.name === name)).toBe(true);
    });
  }

  const undo = toasts.items.filter((item) => item.action?.label === 'Undo');
  expect(undo.map((item) => item.message)).toEqual(['2 theme changes']);
  undo[0]?.action?.run();
  expect(customThemes.themes.map((theme) => theme.id)).toEqual(['mine']);
  expect(customThemes.darkThemeId).toBe('mine');
  expect(customThemes.lightThemeId).toBeNull();
  await unmount(instance);
});

test('asking to remove a theme settles the pending undo', async () => {
  stubCatalog();
  const instance = mount(CustomThemes, { target: document.body });
  await openCatalog();
  tile('Night')
    ?.closest('.tile')
    ?.querySelector<HTMLButtonElement>('.tile-actions button')
    ?.click();
  await vi.waitFor(() => {
    expect(toasts.items.some((item) => item.action?.label === 'Undo')).toBe(true);
  });
  document.querySelector<HTMLButtonElement>('[aria-label="Close catalogue"]')?.click();
  flushSync();

  document.querySelector<HTMLButtonElement>('[aria-label="Remove Night"]')?.click();
  flushSync();
  expect(toasts.items.some((item) => item.action?.label === 'Undo')).toBe(false);
  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night']);
  await unmount(instance);
});
