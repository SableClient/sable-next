import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js', () => import('#lib/core/__mocks__/context.js'));
vi.mock('#lib/features/call/call-session.svelte.js', () => ({
  useCallSession: () => ({ active: false, roomId: null }),
}));
vi.mock('#lib/spaces/sidebar-layout.svelte.js', () => ({
  useSpaceSidebar: () => ({ items: [], openFolders: new Set() }),
}));
vi.mock('#lib/rooms/presence.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/presence.svelte.js')>()),
  usePresenceStore: () => ({ get: () => null, peek: () => null }),
}));

import type { CoreClient } from '#lib/core/client.svelte.js';
import { core } from '#lib/core/__mocks__/context.js';
import { expectNoA11yViolations, ICONS_HIDDEN_BY_LAYOUT } from '#lib/test-support/a11y.js';
import { visit } from '#lib/test-support/app-state.js';
import { matchesAppLayout } from '#lib/ui/app-layout.svelte.js';
import Harness from './AppShellHarness.test.svelte';

const shellCore = core as unknown as CoreClient;

beforeEach(() => {
  Object.assign(core, {
    accounts: [],
    crashed: null,
    localNetworkBlocked: null,
    verification: null,
  });
  visit('/inbox');
});

afterEach(async () => {
  document.documentElement.style.removeProperty('--safe-area-inset-left');
  document.documentElement.style.removeProperty('--safe-area-inset-right');
  document.documentElement.style.removeProperty('--safe-area-inset-bottom');
  await page.viewport(414, 800);
});

test('phone landscape keeps compact navigation and clears the safe areas', async () => {
  await page.viewport(844, 390);
  document.documentElement.style.setProperty('--safe-area-inset-left', '44px');
  document.documentElement.style.setProperty('--safe-area-inset-right', '44px');
  document.documentElement.style.setProperty('--safe-area-inset-bottom', '21px');
  const screen = await render(Harness, { core: shellCore });

  await expect.poll(() => matchesAppLayout()).toBe(false);
  const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
  await expect.element(nav).toBeVisible();
  expect(document.querySelectorAll('.sidebar .desktop-navigation')).toHaveLength(0);
  const sidebar = document.querySelector('.sidebar') as HTMLElement;
  expect(getComputedStyle(sidebar).position).toBe('static');
  const content = screen.getByRole('button', { name: 'Page content' });
  await expect.element(content).toBeVisible();
  const rect = content.element().getBoundingClientRect();
  expect(rect.left).toBeCloseTo(44);
  expect(rect.right).toBeLessThanOrEqual(800);
  const tools = document.querySelector('.content-panel .mobile-tools') as HTMLElement;
  const box = tools.getBoundingClientRect();
  expect(box.left).toBeCloseTo(44);
  expect(box.right).toBeCloseTo(800);
  expect(box.bottom).toBeCloseTo(390);
  const inboxBox = (
    tools.querySelector('a[href="/inbox"]') as HTMLAnchorElement
  ).getBoundingClientRect();
  expect(inboxBox.height).toBeGreaterThanOrEqual(44);
  expect(inboxBox.bottom).toBeLessThanOrEqual(369);
  await expectNoA11yViolations(screen.container, { disableRules: ICONS_HIDDEN_BY_LAYOUT });
});

test('tablet shows fixed desktop navigation with room for the drawer', async () => {
  await page.viewport(768, 1024);
  const screen = await render(Harness, { core: shellCore });

  await expect.poll(() => matchesAppLayout()).toBe(true);
  await expect
    .element(screen.getByRole('navigation', { name: 'Primary navigation' }))
    .toBeVisible();
  expect(document.querySelectorAll('.sidebar .desktop-navigation')).toHaveLength(1);
  const sidebar = document.querySelector('.sidebar') as HTMLElement;
  expect(getComputedStyle(sidebar).position).toBe('fixed');
  const drawer = document.querySelector('.drawer-viewport') as HTMLElement;
  expect(Number.parseFloat(getComputedStyle(drawer).marginLeft)).toBeGreaterThan(0);
  await expectNoA11yViolations(screen.container, {
    disableRules: {
      ...ICONS_HIDDEN_BY_LAYOUT,
      'target-size':
        'the sidebar resize handle is a thin drag edge that the arrow, Home and End keys also operate',
    },
  });
});
