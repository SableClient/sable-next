// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { customThemes, replaceCustomThemes } from '#lib/settings/custom-themes.svelte.js';

import ThemeFileCard from './ThemeFileCard.svelte';

const THEME = `/*
@sable-theme
name: Night Owl
kind: dark
*/
:root { --sable-bg-container: #101018; --sable-primary-main: #7c5cff; }`;

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
  localStorage.clear();
});

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent.trim() === label
  );
}

test('previews a shared theme and installs it once confirmed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(THEME)))
  );
  const instance = mount(ThemeFileCard, {
    target: document.body,
    props: { src: 'blob:theme', name: 'night-owl.sable.css' },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.theme-file-name')?.textContent).toBe('Night Owl');
  });
  expect(document.querySelector('.theme-file-kind')?.textContent).toBe('Dark theme');
  expect(document.querySelectorAll('.theme-file-swatch')).toHaveLength(2);

  button('Install')?.click();
  flushSync();
  expect(customThemes.themes).toEqual([]);

  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (node) => node.textContent.trim() === 'Install'
  );
  confirm?.click();
  flushSync();

  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night Owl']);
  expect(button('Installed')?.disabled).toBe(true);
  await unmount(instance);
});

test('shows nothing for a css file that is not a theme', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response('.x { color: red }')));
  vi.stubGlobal('fetch', fetch);
  const instance = mount(ThemeFileCard, {
    target: document.body,
    props: { src: 'blob:plain', name: 'plain.sable.css' },
  });
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  flushSync();

  expect(document.querySelector('.theme-file-card')).toBeNull();
  await unmount(instance);
});
