// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import {
  customThemes,
  replaceCustomThemes,
  themePreview,
} from '#lib/settings/custom-themes.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import CustomThemes from './CustomThemes.svelte';
import { CATALOG_URL } from './theme-catalog';

const FILES = 'https://git.sable.moe/SableClient/themes/raw/branch/main/';
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

const user = userEvent.setup();

async function openCatalog(): Promise<void> {
  await user.click(button('Theme catalogue'));
  await vi.waitFor(() => {
    expect(installButtons()).toHaveLength(2);
  });
}

const catalog = () => within(screen.getByRole('tabpanel'));

function installButtons(): HTMLElement[] {
  return catalog().queryAllByRole('button', { name: 'Install' });
}

function catalogCard(name: string) {
  return within(catalog().getByTitle(name).closest<HTMLElement>('.tile') ?? document.body);
}

function installButton(name: string): HTMLElement | null {
  return catalogCard(name).queryByRole('button', { name: 'Install' });
}

function tile(name: string): HTMLElement {
  return screen.getAllByTitle(name)[0];
}

afterEach(() => {
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
  localStorage.clear();
});

const button = (name: string) => screen.getByRole('button', { name });

test('offers the built-in theme in both slots, chosen by default', () => {
  render(CustomThemes);

  const radios = screen.getAllByRole('radio');
  expect(radios.map((radio) => radio.textContent.trim())).toEqual([
    'Sable (default)',
    'Sable (default)',
  ]);
  for (const radio of radios) expect(radio).toBeChecked();
});

test('onboarding selects one mode and activates a theme chosen from the catalogue', async () => {
  stubCatalog();
  const onThemeChosen = vi.fn();
  render(CustomThemes, { onboarding: true, onThemeChosen });

  const modes = within(screen.getByRole('radiogroup', { name: 'Theme' }));
  expect(modes.getAllByRole('radio').map((radio) => radio.textContent.trim())).toEqual([
    'Light',
    'Dark',
  ]);
  expect(modes.getAllByRole('radio', { checked: true })).toHaveLength(1);

  await user.click(button('Browse more themes'));
  await vi.waitFor(() => {
    expect(installButtons()).toHaveLength(2);
  });
  await user.click(installButton('Night') ?? document.body);
  await vi.waitFor(() => {
    expect(onThemeChosen).toHaveBeenCalledWith('dark');
  });
  expect(customThemes.darkThemeId).toBe(customThemes.themes[0]?.id);
});

test('keeps the selected installed theme first in the scrollable list', () => {
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
  render(CustomThemes);

  expect(tile('Dark 5')).toBeInTheDocument();
  expect(tile('Dark 4')).toBeInTheDocument();
  const preview = tile('Dark 5').querySelector<HTMLElement>('.preview');
  expect(preview?.style.getPropertyValue('--tile-radius')).toBe('0');
  expect(preview?.style.getPropertyValue('--tile-radius-inner')).toBe('2px');
});

test('lists each slot by theme kind, keeping a cross-kind choice', () => {
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
  render(CustomThemes);

  const names = (slot: string): string[] =>
    within(document.getElementById(`theme-slot-${slot}-items`) ?? document.body)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('title') ?? '');
  expect(names('light')).toEqual(['Sable (default)', 'Dawn', 'Dusk']);
  expect(names('dark')).toEqual(['Sable (default)', 'Night', 'Dusk']);
});

test('installs a catalogue theme into its own mode without using it, and undoes it', async () => {
  stubCatalog();
  render(CustomThemes);

  await openCatalog();
  expect(screen.queryByText(/elsewhere/)).not.toBeInTheDocument();
  expect(fetched.some((url) => url.includes('evil.example'))).toBe(false);

  await user.click(installButton('Night') ?? document.body);
  await vi.waitFor(() => {
    expect(customThemes.themes.map((theme) => theme.source)).toEqual([NIGHT_URL]);
  });
  expect(customThemes.darkThemeId).toBeNull();
  expect(installButton('Night')).not.toBeInTheDocument();
  expect(catalogCard('Night').getByText('Installed')).toBeInTheDocument();

  const toast = toasts.items.find((item) => item.message === 'Night installed');
  expect(toast?.action?.label).toBe('Undo');
  toast?.action?.run();
  expect(customThemes.themes).toEqual([]);
});

test('tapping a card previews it without installing, and Use installs it', async () => {
  stubCatalog();
  render(CustomThemes);
  await openCatalog();

  await user.click(catalog().getByTitle('Night'));
  await vi.waitFor(() => {
    expect(themePreview.current?.name).toBe('Night');
  });
  expect(customThemes.themes).toEqual([]);

  await user.click(button('Use for dark mode'));
  expect(themePreview.current).toBeNull();
  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night']);
  expect(customThemes.darkThemeId).toBe(customThemes.themes[0]?.id);
  expect(catalogCard('Night').getByText('In use for dark mode')).toBeInTheDocument();

  await user.click(catalog().getByTitle('Dawn'));
  await vi.waitFor(() => {
    expect(themePreview.current?.name).toBe('Dawn');
  });
  await user.click(button('Close catalogue'));
  expect(themePreview.current).toBeNull();
  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night']);
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
  render(CustomThemes);
  await openCatalog();

  for (const name of ['Night', 'Dawn']) {
    await user.click(installButton(name) ?? document.body);
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
});

test('removing a theme offers an undo that restores it to its slot', async () => {
  replaceCustomThemes({
    themes: [{ id: 'night', name: 'Night', kind: 'dark', css: '/* @sable-theme */' }],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: 'night',
    enabledTweakIds: [],
  });
  render(CustomThemes);

  await user.click(button('Remove Night'));
  expect(customThemes.themes).toEqual([]);
  expect(customThemes.darkThemeId).toBeNull();

  const toast = toasts.items.find((item) => item.message === 'Night removed');
  toast?.action?.run();
  expect(customThemes.themes.map((theme) => theme.id)).toEqual(['night']);
  expect(customThemes.darkThemeId).toBe('night');
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
  render(CustomThemes);
  const radios = () =>
    within(document.getElementById('theme-slot-dark-items') ?? document.body).getAllByRole('radio');
  expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

  radios()[0].focus();
  await user.keyboard('{ArrowRight}');
  expect(customThemes.darkThemeId).toBe('night');
  await vi.waitFor(() => {
    expect(radios()[1]).toHaveFocus();
  });
  await user.keyboard('{End}');
  expect(customThemes.darkThemeId).toBe('dusk');
  await user.keyboard('{ArrowRight}');
  expect(customThemes.darkThemeId).toBeNull();

  await user.keyboard('{End}');
  await user.keyboard('{Delete}');
  expect(customThemes.themes.map((theme) => theme.id)).toEqual(['night']);
});

test('a failed catalogue install says so on its own card', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(url === DAWN_URL ? new Response('', { status: 500 }) : respond(url))
    )
  );
  render(CustomThemes);
  await user.click(button('Theme catalogue'));
  await vi.waitFor(() => {
    expect(installButton('Dawn')).toBeInTheDocument();
  });

  await user.click(installButton('Dawn') ?? document.body);
  expect(await catalogCard('Dawn').findByRole('alert')).toBeInTheDocument();
  expect(catalogCard('Night').queryByRole('alert')).not.toBeInTheDocument();
  expect(customThemes.themes).toEqual([]);
});

test('closing the catalogue discards a preview that is still downloading', async () => {
  stubCatalog();
  render(CustomThemes);
  await openCatalog();
  const pending = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => pending.promise)
  );

  await user.click(catalog().getByTitle('Night'));
  await user.click(button('Close catalogue'));
  pending.resolve(new Response(NIGHT));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(themePreview.current).toBeNull();
});

test('the most recently clicked preview wins when downloads finish out of order', async () => {
  stubCatalog();
  render(CustomThemes);
  await openCatalog();
  const night = Promise.withResolvers<Response>();
  const dawn = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => (url === NIGHT_URL ? night.promise : dawn.promise))
  );

  await user.click(catalog().getByTitle('Night'));
  await user.click(catalog().getByTitle('Dawn'));
  dawn.resolve(new Response(DAWN));
  await vi.waitFor(() => {
    expect(themePreview.current?.name).toBe('Dawn');
  });
  night.resolve(new Response(NIGHT));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(themePreview.current?.name).toBe('Dawn');
});

test('leaving settings discards a preview that is still downloading', async () => {
  stubCatalog();
  const { unmount } = render(CustomThemes);
  await openCatalog();
  const pending = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => pending.promise)
  );

  await user.click(catalog().getByTitle('Night'));
  unmount();
  pending.resolve(new Response(NIGHT));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(themePreview.current).toBeNull();
});

test.each(['Revert', 'Use for dark mode'])(
  '%s discards a newer preview that is still downloading',
  async (action) => {
    stubCatalog();
    render(CustomThemes);
    await openCatalog();
    await user.click(catalog().getByTitle('Night'));
    await vi.waitFor(() => {
      expect(themePreview.current?.name).toBe('Night');
    });
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pending.promise)
    );

    await user.click(catalog().getByTitle('Dawn'));
    await user.click(button(action));
    pending.resolve(new Response(DAWN));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(themePreview.current).toBeNull();
    expect(customThemes.themes.map((theme) => theme.name)).toEqual(
      action === 'Revert' ? [] : ['Night']
    );
  }
);

test('a superseded preview failure does not clear the current download or show an error', async () => {
  stubCatalog();
  render(CustomThemes);
  await openCatalog();
  const night = Promise.withResolvers<Response>();
  const dawn = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => (url === NIGHT_URL ? night.promise : dawn.promise))
  );

  await user.click(catalog().getByTitle('Night'));
  await user.click(catalog().getByTitle('Dawn'));
  night.resolve(new Response('', { status: 500 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(installButton('Dawn')).toBeDisabled();
  expect(catalogCard('Night').queryByRole('alert')).not.toBeInTheDocument();
  dawn.resolve(new Response(DAWN));
  await vi.waitFor(() => {
    expect(themePreview.current?.name).toBe('Dawn');
  });
  expect(installButton('Dawn')).toBeEnabled();
});
