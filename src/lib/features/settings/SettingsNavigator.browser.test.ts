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

import SettingsNavigator from './SettingsNavigator.svelte';
import SettingsNavigatorHarness from './SettingsNavigatorHarness.test.svelte';

afterEach(async () => {
  await page.viewport(414, 800);
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

test('typing filters settings by their name across categories', async () => {
  const { field, results } = await mount();
  await userEvent.fill(field.element(), 'autoplay gifs');

  await expect.poll(() => results.elements().length).toBe(1);
  expect(results.element().textContent).toContain('Autoplay GIFs');
  expect(results.element().textContent).toContain('In Media');
});

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
});

test('a query matching nothing says so', async () => {
  const { screen, field } = await mount();
  await userEvent.fill(field.element(), 'zzzznothingmatchesthis');

  await expect.element(screen.getByText(/No settings match/)).toBeVisible();
  expect(document.querySelectorAll('[aria-label="Search settings"] li')).toHaveLength(0);
});
