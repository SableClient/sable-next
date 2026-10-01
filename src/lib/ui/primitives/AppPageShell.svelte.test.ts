// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import { PageMeta } from '#lib/core/page-meta.js';
import AppPageShell from './AppPageShell.svelte';
import AppPageShellHarness from './AppPageShellHarness.test.svelte';

test('renders without page metadata', () => {
  render(AppPageShell, { title: 'Room settings' });

  expect(screen.getByRole('heading', { name: 'Room settings' })).toBeInTheDocument();
});

test('updates provided page metadata when the title changes', async () => {
  const pageMeta = new PageMeta();
  const view = render(AppPageShellHarness, { title: 'Settings', pageMeta });

  expect(pageMeta.title).toBe('Settings');

  await view.rerender({ title: 'Account' });

  expect(pageMeta.title).toBe('Account');
});
