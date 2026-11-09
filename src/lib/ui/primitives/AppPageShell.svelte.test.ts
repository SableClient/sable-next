// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test } from 'vitest';

import { PageMeta } from '#lib/core/page-meta.js';
import AppPageShell from './AppPageShell.svelte';
import AppPageShellHarness from './AppPageShellHarness.test.svelte';

test('updates provided page metadata when the title changes', async () => {
  const pageMeta = new PageMeta();
  const view = render(AppPageShellHarness, { title: 'Settings', pageMeta });

  expect(pageMeta.title).toBe('Settings');

  await view.rerender({ title: 'Account' });

  expect(pageMeta.title).toBe('Account');
});

test('titles the document after the page', async () => {
  render(AppPageShell, { title: 'Developer' });
  await tick();

  expect(document.title).toBe('Developer - Sable');
});
