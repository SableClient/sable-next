// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import type { Window as HappyDOMWindow } from 'happy-dom';
import { createRawSnippet } from 'svelte';
import { expect, onTestFinished, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/core/context.js');
vi.mock('./SidebarNav.svelte', () => import('./PreventedLinkHarness.test.svelte'));
vi.mock('./UserQuickTools.svelte', () => ({ default: () => {} }));
vi.mock('#lib/ui/CoreHealthBanner.svelte', () => ({ default: () => {} }));

import { goto } from '#lib/test-support/app-navigation.js';
import { page, visit } from '#lib/test-support/app-state.js';

import MobileNavDrawer from './MobileNavDrawer.svelte';

test('leaves a link click that was already handled to its own handler', async () => {
  const happyDOM = (window as unknown as HappyDOMWindow).happyDOM;
  const size = { width: window.innerWidth, height: window.innerHeight };
  happyDOM.setViewport({ width: 390, height: 844 });
  onTestFinished(() => {
    happyDOM.setViewport(size);
  });
  visit('/rooms/!room%3Aexample.org', { roomId: '!room:example.org' });
  page.state.mobileDrawer = 'open';
  render(MobileNavDrawer, {
    children: createRawSnippet(() => ({ render: () => '<p>Room</p>' })),
  });

  await userEvent.click(screen.getByRole('link', { name: 'Next room' }));

  expect(goto).not.toHaveBeenCalled();
});
