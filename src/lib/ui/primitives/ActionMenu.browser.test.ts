import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import '../../../styles.css';
import ActionMenuHarness from './ActionMenuHarness.test.svelte';

test('opening a menu does not pad the page by a bogus scrollbar width', async () => {
  await page.viewport(1280, 800);
  const clientWidth = vi
    .spyOn(document.documentElement, 'clientWidth', 'get')
    .mockImplementation(() => window.innerWidth - 871);
  const screen = await render(ActionMenuHarness, { onPick: vi.fn() });

  await screen.getByRole('button', { name: 'Room options' }).click();
  await expect.element(screen.getByRole('menu', { name: 'Room options' })).toBeVisible();

  expect(document.body.style.paddingRight).toBe('871px');
  expect(getComputedStyle(document.body).paddingRight).toBe('0px');
  clientWidth.mockRestore();
});
