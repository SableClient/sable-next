// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
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

test('previews a shared theme and installs it once confirmed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(THEME)))
  );
  const user = userEvent.setup();
  const { container } = render(ThemeFileCard, { src: 'blob:theme', name: 'night-owl.sable.css' });
  expect(await screen.findByText('Night Owl')).toBeInTheDocument();
  expect(screen.getByText('Dark theme')).toBeInTheDocument();
  expect(container.querySelectorAll('.swatch')).toHaveLength(2);

  await user.click(screen.getByRole('button', { name: 'Install' }));
  expect(customThemes.themes).toEqual([]);

  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Install' })
  );

  expect(customThemes.themes.map((theme) => theme.name)).toEqual(['Night Owl']);
  expect(screen.getByRole('button', { name: 'Installed' })).toBeDisabled();
});

test('shows nothing for a css file that is not a theme', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response('.x { color: red }')));
  vi.stubGlobal('fetch', fetch);
  render(ThemeFileCard, { src: 'blob:plain', name: 'plain.sable.css' });
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });

  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
