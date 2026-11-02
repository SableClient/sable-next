import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { preferences } from '#lib/settings/preferences.svelte.js';

import UnreadBadge from './UnreadBadge.svelte';
import UnreadBadgeHarness from './UnreadBadgeHarness.test.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateReducedMotion: (motion: 'reduce' | 'no-preference') => Promise<void>;
  }
}

const animations = () => document.querySelector('.unread-badge')?.getAnimations() ?? [];
const original = preferences.reducedMotion;

beforeEach(async () => {
  await commands.emulateReducedMotion('no-preference');
  preferences.reducedMotion = false;
});

afterEach(async () => {
  preferences.reducedMotion = original;
  await commands.emulateReducedMotion('reduce');
});

test('a badge already unread when its row renders appears without animating', async () => {
  await render(UnreadBadge, { counts: { unread: 3, highlight: 0 } });

  expect(animations()).toHaveLength(0);
});

test('a badge that turns unread on a shown row scales in', async () => {
  await render(UnreadBadgeHarness);
  await userEvent.click(page.getByRole('button', { name: 'Receive' }));

  await vi.waitFor(() => {
    expect(animations()).toHaveLength(1);
  });
});
