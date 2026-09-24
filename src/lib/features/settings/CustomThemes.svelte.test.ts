// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { customThemes, replaceCustomThemes } from '#lib/settings/custom-themes.svelte.js';

import CustomThemes from './CustomThemes.svelte';
import { CATALOG_URL } from './theme-catalog';

const NIGHT_URL = 'https://example.org/night.sable.css';
const NIGHT = `/*
@sable-theme
name: Night
author: ana
kind: dark
*/
.x { --sable-bg-container: #101018; }`;

function respond(url: string): Response {
  if (url === CATALOG_URL) {
    return Response.json({
      themes: [
        {
          basename: 'night',
          previewUrl: 'https://example.org/night.preview.sable.css',
          fullUrl: NIGHT_URL,
        },
      ],
      tweaks: [],
    });
  }
  return new Response(NIGHT);
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
  localStorage.clear();
});

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent.trim() === label
  );
}

test('browses the catalogue, installs a theme and marks it installed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(respond(url)))
  );
  const instance = mount(CustomThemes, { target: document.body });

  button('Browse Catalogue')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.catalog .name')?.textContent).toBe('Night');
  });
  expect(document.querySelector('.catalog .meta')?.textContent).toContain('by ana');

  button('Install')?.click();
  await vi.waitFor(() => {
    expect(customThemes.themes.map((theme) => theme.source)).toEqual([NIGHT_URL]);
  });
  flushSync();
  expect(button('Installed')?.disabled).toBe(true);
  expect(customThemes.darkThemeId).toBe(customThemes.themes[0]?.id);

  button('In use')?.click();
  flushSync();
  expect(customThemes.darkThemeId).toBeNull();
  await unmount(instance);
});
