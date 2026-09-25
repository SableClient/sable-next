// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
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
  button('Theme catalogue')?.click();
  await vi.waitFor(() => {
    expect(installButtons()).toHaveLength(2);
  });
}

function installButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.catalog .tile-actions button')];
}

function installButton(name: string): HTMLButtonElement | null | undefined {
  return catalogTile(name)
    ?.closest('.tile')
    ?.querySelector<HTMLButtonElement>('.tile-actions button');
}

function tile(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.tile-hit')].find((node) =>
    node.textContent.includes(name)
  );
}

function catalogTile(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.catalog .tile-hit')].find((node) =>
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
  expect(radios.map((radio) => radio.textContent.trim())).toEqual([
    'Sable (default)',
    'Sable (default)',
  ]);
  expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'true')).toBe(true);
  await unmount(instance);
});

test('keeps the selected installed theme first in the scrollable list', async () => {
  replaceCustomThemes({
    themes: Array.from({ length: 5 }, (_, index) => ({
      id: `dark-${String(index + 1)}`,
      name: `Dark ${String(index + 1)}`,
      kind: 'dark' as const,
      css: `/* @sable-theme */ .x { --radius: ${index === 4 ? '0' : '8px'}; --radius-inner: 2px; }`,
    })),
    tweaks: [],
    lightThemeId: null,
    darkThemeId: 'dark-5',
    enabledTweakIds: [],
  });
  const instance = mount(CustomThemes, { target: document.body });

  expect(tile('Dark 5')).toBeDefined();
  expect(tile('Dark 4')).toBeDefined();
  expect(
    tile('Dark 5')?.querySelector<HTMLElement>('.preview')?.style.getPropertyValue('--tile-radius')
  ).toBe('0');
  expect(
    tile('Dark 5')
      ?.querySelector<HTMLElement>('.preview')
      ?.style.getPropertyValue('--tile-radius-inner')
  ).toBe('2px');

  await unmount(instance);
});

test('lists each slot by theme kind, keeping a cross-kind choice', async () => {
  replaceCustomThemes({
    themes: [
      { id: 'dawn', name: 'Dawn', kind: 'light', css: '/* @sable-theme */' },
      { id: 'night', name: 'Night', kind: 'dark', css: '/* @sable-theme */' },
      { id: 'dusk', name: 'Dusk', kind: 'dark', css: '/* @sable-theme */' },
    ],
    tweaks: [],
    lightThemeId: 'dusk',
    darkThemeId: null,
    enabledTweakIds: [],
  });
  const instance = mount(CustomThemes, { target: document.body });

  const names = (slot: string): string[] =>
    [...document.querySelectorAll(`#theme-slot-${slot}-items .tile-name`)].map((node) =>
      node.textContent.trim()
    );
  expect(names('light')).toEqual(['Sable (default)', 'Dawn', 'Dusk']);
  expect(names('dark')).toEqual(['Sable (default)', 'Night', 'Dusk']);
  await unmount(instance);
});

test('installs a catalogue theme into its own mode without using it, and undoes it', async () => {
  stubCatalog();
  const instance = mount(CustomThemes, { target: document.body });

  await openCatalog();
  expect(document.body.textContent).not.toContain('elsewhere');
  expect(fetched.some((url) => url.includes('evil.example'))).toBe(false);

  installButton('Night')?.click();
  await vi.waitFor(() => {
    expect(customThemes.themes.map((theme) => theme.source)).toEqual([NIGHT_URL]);
  });
  expect(customThemes.darkThemeId).toBeNull();
  flushSync();
  expect(installButton('Night')).toBeNull();
  expect(catalogTile('Night')?.closest('.tile')?.textContent).toContain('Installed');

  const toast = toasts.items.find((item) => item.message === 'Night installed');
  expect(toast?.action?.label).toBe('Undo');
  toast?.action?.run();
  expect(customThemes.themes).toEqual([]);
  await unmount(instance);
});

test('tapping a card previews it without installing, and Use installs it', async () => {
  stubCatalog();
  const instance = mount(CustomThemes, { target: document.body });
  await openCatalog();

  tile('Night')?.click();
  await vi.waitFor(() => {
    expect(themePreview.current?.name).toBe('Night');
  });
  expect(customThemes.themes).toEqual([]);

  flushSync();
  button('Use for dark mode')?.click();
  expect(themePreview.current).toBeNull();
  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night']);
  expect(customThemes.darkThemeId).toBe(customThemes.themes[0]?.id);
  flushSync();
  expect(catalogTile('Night')?.closest('.tile')?.textContent).toContain('In use for dark mode');

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
    installButton(name)?.click();
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

test('removing a theme offers an undo that restores it to its slot', async () => {
  replaceCustomThemes({
    themes: [{ id: 'night', name: 'Night', kind: 'dark', css: '/* @sable-theme */' }],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: 'night',
    enabledTweakIds: [],
  });
  const instance = mount(CustomThemes, { target: document.body });

  document.querySelector<HTMLButtonElement>('[aria-label="Remove Night"]')?.click();
  flushSync();
  expect(customThemes.themes).toEqual([]);
  expect(customThemes.darkThemeId).toBeNull();

  const toast = toasts.items.find((item) => item.message === 'Night removed');
  toast?.action?.run();
  expect(customThemes.themes.map((theme) => theme.id)).toEqual(['night']);
  expect(customThemes.darkThemeId).toBe('night');
  await unmount(instance);
});

test('arrow keys move the choice within a slot and Delete removes the focused theme', async () => {
  replaceCustomThemes({
    themes: [
      { id: 'night', name: 'Night', kind: 'dark', css: '/* @sable-theme */' },
      { id: 'dusk', name: 'Dusk', kind: 'dark', css: '/* @sable-theme */' },
    ],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  });
  const instance = mount(CustomThemes, { target: document.body });
  const radios = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('#theme-slot-dark-items [role="radio"]'),
  ];
  expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

  const press = async (key: string): Promise<void> => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await tick();
  };
  radios()[0]?.focus();
  await press('ArrowRight');
  expect(customThemes.darkThemeId).toBe('night');
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(radios()[1]);
  });
  await press('End');
  expect(customThemes.darkThemeId).toBe('dusk');
  await press('ArrowRight');
  expect(customThemes.darkThemeId).toBeNull();

  await press('End');
  await press('Delete');
  expect(customThemes.themes.map((theme) => theme.id)).toEqual(['night']);
  await unmount(instance);
});

test('a failed catalogue install says so on its own card', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(url === DAWN_URL ? new Response('', { status: 500 }) : respond(url))
    )
  );
  const instance = mount(CustomThemes, { target: document.body });
  button('Theme catalogue')?.click();
  await vi.waitFor(() => {
    expect(installButton('Dawn')).toBeDefined();
  });

  installButton('Dawn')?.click();
  await vi.waitFor(() => {
    expect(catalogTile('Dawn')?.closest('.tile')?.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(catalogTile('Night')?.closest('.tile')?.querySelector('[role="alert"]')).toBeNull();
  expect(customThemes.themes).toEqual([]);
  await unmount(instance);
});
