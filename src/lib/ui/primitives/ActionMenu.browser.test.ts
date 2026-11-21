import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import '../../../styles.css';
import ActionMenuHarness from './ActionMenuHarness.test.svelte';

test('a click outside an open menu reaches the control it lands on', async () => {
  await page.viewport(1280, 800);
  const onOutside = vi.fn();
  const screen = await render(ActionMenuHarness, { onPick: vi.fn(), onOutside });

  await screen.getByRole('button', { name: 'Room options' }).click();
  const menu = screen.getByRole('menu', { name: 'Room options' });
  await expect.element(menu).toBeVisible();

  await screen.getByRole('button', { name: 'Outside' }).click({ timeout: 2000 });

  expect(onOutside).toHaveBeenCalledOnce();
  await expect.element(menu).not.toBeInTheDocument();
});
