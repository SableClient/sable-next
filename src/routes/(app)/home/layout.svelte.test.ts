// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { goto } from '$app/navigation';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import Layout from './+layout.svelte';

afterEach(() => {
  setPreference('showHome', false);
});

function renderHome() {
  return render(Layout, {
    children: createRawSnippet(() => ({ render: () => '<p>Home content</p>' })),
  });
}

test('redirects to rooms without rendering Home when disabled', async () => {
  setPreference('showHome', false);
  renderHome();
  await tick();

  expect(goto).toHaveBeenCalledWith('/rooms', { replace: true });
  expect(screen.queryByText('Home content')).not.toBeInTheDocument();
});

test('renders Home when enabled', async () => {
  setPreference('showHome', true);
  renderHome();
  await tick();

  expect(screen.getByText('Home content')).toBeInTheDocument();
  expect(goto).not.toHaveBeenCalled();
});

test('redirects when Home is disabled while open', async () => {
  setPreference('showHome', true);
  renderHome();
  await tick();

  setPreference('showHome', false);
  await tick();

  expect(goto).toHaveBeenCalledWith('/rooms', { replace: true });
  expect(screen.queryByText('Home content')).not.toBeInTheDocument();
});
