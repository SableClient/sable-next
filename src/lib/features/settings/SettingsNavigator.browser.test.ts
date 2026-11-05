import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { core } from '#lib/core/__mocks__/context.js';
import { expectNoA11yViolations, ICONS_HIDDEN_BY_LAYOUT } from '#lib/test-support/a11y.js';

import SettingsNavigator from './SettingsNavigator.svelte';
import SettingsNavigatorHarness from './SettingsNavigatorHarness.test.svelte';
import SettingsPanel from './SettingsPanel.svelte';

afterEach(async () => {
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    document.documentElement.style.removeProperty(`--safe-area-inset-${edge}`);
  }
  await page.viewport(414, 800);
});

test('mobile settings clear asymmetric safe areas', async () => {
  await page.viewport(375, 560);
  Object.assign(core, { session: { user_id: '@me:example.org' }, encryption: null });
  core.commands = core;
  const screen = await render(SettingsPanel, { section: null });
  const field = screen.getByRole('searchbox', { name: 'Search settings' });
  await expect.element(field).toBeVisible();
  for (const [width, left, right] of [
    [375, 0, 48],
    [375, 48, 0],
    [768, 0, 48],
    [1280, 48, 0],
  ]) {
    await page.viewport(width, 560);
    document.documentElement.style.setProperty('--safe-area-inset-top', '32px');
    document.documentElement.style.setProperty('--safe-area-inset-left', `${left}px`);
    document.documentElement.style.setProperty('--safe-area-inset-right', `${right}px`);
    for (const element of [
      field.element(),
      screen.getByRole('button', { name: 'Close', exact: true }).element(),
    ]) {
      const rect = element.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(left);
      expect(rect.right).toBeLessThanOrEqual(width - right);
      expect(rect.top).toBeGreaterThanOrEqual(32);
    }
  }
  await expectNoA11yViolations(screen.container, { disableRules: ICONS_HIDDEN_BY_LAYOUT });
});

async function mount() {
  await page.viewport(1280, 900);
  Object.assign(core, { session: { user_id: '@me:example.org' }, encryption: null });
  core.commands = core;
  const screen = await render(SettingsNavigatorHarness, { component: SettingsNavigator });
  const field = screen.getByRole('searchbox', { name: 'Search settings' });
  const results = screen.getByRole('list', { name: 'Search settings' }).getByRole('listitem');
  return { screen, field, results };
}

test.each(['autoplay animated images', 'autoplay gifs', 'webp', 'apng', 'avif'])(
  'finds the animation autoplay setting for "%s"',
  async (query) => {
    const { screen, field } = await mount();
    await userEvent.fill(field.element(), query);

    await expect
      .element(screen.getByText('Autoplay animated images', { exact: true }))
      .toBeVisible();
  }
);

test('typing matches on the translated description, not just the name', async () => {
  const { field, results } = await mount();
  await userEvent.fill(field.element(), 'lock screen');

  await expect.poll(() => results.elements().length).toBe(1);
  expect(results.element().textContent).toContain('Show message text');
  expect(results.element().textContent).toContain('In Notifications');
});

test('the summary reports how many results there are', async () => {
  const { screen, field, results } = await mount();
  await userEvent.fill(field.element(), 'notification');

  await expect.poll(() => results.elements().length).toBeGreaterThan(1);
  const count = results.elements().length;
  await expect.element(screen.getByText(`${String(count)} results`)).toBeVisible();

  await userEvent.fill(field.element(), 'autoplay gifs');
  await expect.element(screen.getByText('1 result', { exact: true })).toBeVisible();
  await expectNoA11yViolations(screen.container);
});

test('a query matching nothing says so', async () => {
  const { screen, field } = await mount();
  await userEvent.fill(field.element(), 'zzzznothingmatchesthis');

  await expect.element(screen.getByText(/No settings match/)).toBeVisible();
  expect(document.querySelectorAll('[aria-label="Search settings"] li')).toHaveLength(0);
});

test.each([
  [1280, 900],
  [412, 915],
])('custom panel search links work at %s x %s', async (width, height) => {
  const { screen, field } = await mount();
  await page.viewport(width, height);
  await userEvent.fill(field.element(), 'quick CSS');
  const css = screen.getByRole('link', { name: /Quick CSS/ });
  await expect.element(css).toBeVisible();
  expect(css.element().getAttribute('href')).toBe('/settings/appearance?focus=quick-css');

  await userEvent.fill(field.element(), 'key backup');
  const backup = screen.getByRole('link', { name: /Cloud key backup/ });
  await expect.element(backup).toBeVisible();
  expect(backup.element().getAttribute('href')).toBe('/settings/devices?focus=key-backup-heading');

  await userEvent.fill(field.element(), 'display name');
  const mention = screen.getByRole('link', { name: /Display name/ });
  await expect.element(mention).toBeVisible();
  expect(mention.element().getAttribute('href')).toBe(
    '/settings/notifications?focus=mention-display_name'
  );
});

test('mobile: log out is the last row of the section list', async () => {
  const { screen } = await mount();
  await page.viewport(412, 915);
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  const logout = nav.getByRole('button', { name: 'Log out' });
  logout.element().scrollIntoView();
  const about = nav.getByRole('link', { name: 'About' }).element().getBoundingClientRect();
  const row = logout.element().getBoundingClientRect();

  expect(row.y).toBeGreaterThan(about.y);
  await expectNoA11yViolations(screen.container, { disableRules: ICONS_HIDDEN_BY_LAYOUT });
});

test('selected settings rows stay inside the sidebar with wide fonts and outline labels', async () => {
  await page.viewport(1280, 900);
  Object.assign(core, { session: { user_id: '@me:example.org' }, encryption: null });
  core.commands = core;
  const screen = await render(SettingsNavigatorHarness, {
    component: SettingsNavigator,
    section: 'notifications',
    outlineLabel: 'Notifications for direct messages and spaces',
  });
  const nav = screen.getByRole('navigation', { name: 'Settings sections' }).element();
  nav.style.fontFamily = 'monospace';
  nav.style.setProperty('--font-size-label', '1.5rem');
  const selected = screen.getByRole('link', { name: 'Notifications', exact: true });
  await expect
    .element(screen.getByRole('link', { name: 'Notifications for direct messages and spaces' }))
    .toBeVisible();

  await expect
    .poll(() => selected.element().getBoundingClientRect().right)
    .toBeLessThanOrEqual(nav.getBoundingClientRect().right);
  expect(nav.scrollWidth).toBeLessThanOrEqual(nav.clientWidth);
});
