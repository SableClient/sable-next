import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { expectNoA11yViolations } from '#lib/test-support/a11y.js';
import { navigated } from '#lib/test-support/app-navigation.js';
import AuthRailHarness from './AuthRailHarness.test.svelte';

afterEach(() => {
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    document.documentElement.style.removeProperty(`--safe-area-inset-${edge}`);
  }
});

test('active cards stay outside the edge fades and system insets', async () => {
  const screen = await render(AuthRailHarness);
  const shell = screen.container.querySelector<HTMLElement>('.rail-shell');
  if (!shell) throw new Error('.rail-shell is not rendered');
  for (const width of [320, 375, 560, 768, 1280]) {
    await page.viewport(width, 560);
    for (const [left, right] of [
      [0, 0],
      [0, 48],
      [48, 0],
    ]) {
      document.documentElement.style.setProperty('--safe-area-inset-top', '32px');
      document.documentElement.style.setProperty('--safe-area-inset-left', `${left}px`);
      document.documentElement.style.setProperty('--safe-area-inset-right', `${right}px`);
      for (const activeIndex of [0, 1]) {
        await screen.rerender({ activeIndex });
        await expect
          .poll(() => {
            const card = activeCard(shell);
            const rail = shell.getBoundingClientRect();
            const fade = Number.parseFloat(getComputedStyle(shell, '::before').width);
            return card.left >= rail.left + fade - 1 && card.right <= rail.right - fade + 1;
          })
          .toBe(true);
        const card = activeCard(shell);
        expect(card.left).toBeGreaterThanOrEqual(left);
        expect(card.right).toBeLessThanOrEqual(width - right);
        const nav = screen
          .getByRole('button', { name: activeIndex === 0 ? 'Next' : 'Back', exact: true })
          .element()
          .getBoundingClientRect();
        expect(nav.left).toBeGreaterThanOrEqual(left);
        expect(nav.right).toBeLessThanOrEqual(width - right);
        expect(nav.top).toBeGreaterThanOrEqual(32);
      }
    }
  }
});

for (const width of [1280, 390]) {
  test(`focus starts at the heading (${String(width)}px)`, async () => {
    await page.viewport(width, 844);
    const screen = await render(AuthRailHarness);
    const heading = screen.getByRole('heading', { name: 'Sign in', exact: true });
    await expect.element(heading).toHaveFocus();
    await userEvent.tab();
    await expect.element(screen.getByRole('textbox', { name: 'Account provider' })).toHaveFocus();
    document.getElementById('new-username')?.focus();
    expect(screen.getByRole('textbox', { name: 'New username' }).elements()).toHaveLength(0);
    await expect.element(screen.getByRole('textbox', { name: 'Account provider' })).toHaveFocus();
    await expectNoA11yViolations(screen.container);
  });
}

test('Next and Back focus the active heading', async () => {
  const screen = await render(AuthRailHarness);
  await userEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
  await expect.element(screen.getByRole('heading', { name: 'Create account' })).toHaveFocus();
  await expectNoA11yViolations(screen.container);
  await userEvent.tab();
  await expect.element(screen.getByRole('textbox', { name: 'New username' })).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: 'Back', exact: true }));
  await expect.element(screen.getByRole('heading', { name: 'Sign in', exact: true })).toHaveFocus();
});

test('startup preserves focus outside the rail', async () => {
  const screen = await render(AuthRailHarness, { booting: true });
  const outside = screen.getByRole('button', { name: 'Outside auth' });
  await userEvent.click(outside);
  await screen.rerender({ booting: false });
  await expect.element(outside).toHaveFocus();
});

test('navigation restores focus only after a router reset', async () => {
  const screen = await render(AuthRailHarness);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  navigated();
  await expect.element(screen.getByRole('heading', { name: 'Sign in', exact: true })).toHaveFocus();
  const outside = screen.getByRole('button', { name: 'Outside auth' });
  await userEvent.click(outside);
  navigated();
  await expect.element(outside).toHaveFocus();
});

function activeCard(shell: HTMLElement): DOMRect {
  const card = shell.querySelector('.auth-card.active');
  if (!card) throw new Error('.auth-card.active is not rendered');
  return card.getBoundingClientRect();
}
