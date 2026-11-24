import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({ holdOverlayBack: () => {} }));

import Harness from './BottomSheetHarness.test.svelte';

beforeEach(async () => {
  await page.viewport(844, 390);
  document.documentElement.dataset.tauriOs = 'ios';
  document.documentElement.style.setProperty('--safe-area-inset-bottom', '21px');
});

afterEach(async () => {
  delete document.documentElement.dataset.tauriOs;
  document.documentElement.style.removeProperty('--keyboard-height');
  document.documentElement.style.removeProperty('--safe-area-inset-left');
  document.documentElement.style.removeProperty('--safe-area-inset-right');
  document.documentElement.style.removeProperty('--safe-area-inset-bottom');
  await page.viewport(414, 800);
});

test.each([
  { os: 'ios', fullHeight: false, keyboard: 0, viewport: 390, bottom: 390 },
  { os: 'ios', fullHeight: true, keyboard: 0, viewport: 390, bottom: 390 },
  { os: 'android', fullHeight: false, keyboard: 0, viewport: 390, bottom: 390 },
  { os: 'android', fullHeight: true, keyboard: 0, viewport: 390, bottom: 390 },
  { os: 'ios', fullHeight: false, keyboard: 190, viewport: 390, bottom: 200 },
  { os: 'ios', fullHeight: true, keyboard: 230, viewport: 390, bottom: 160 },
  { os: 'android', fullHeight: false, keyboard: 190, viewport: 200, bottom: 200 },
  { os: 'android', fullHeight: true, keyboard: 230, viewport: 160, bottom: 160 },
])(
  '$os sheet fits above a $keyboard px keyboard (full height: $fullHeight)',
  async ({ os, fullHeight, keyboard, viewport, bottom }) => {
    document.documentElement.dataset.tauriOs = os;
    const screen = await render(Harness, { fullHeight });
    const dialog = screen.getByRole('dialog', { name: 'Options' });
    await expect.element(dialog).toBeVisible();

    await page.viewport(844, viewport);
    document.documentElement.style.setProperty('--keyboard-height', `${keyboard}px`);

    const rect = dialog.element().getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeCloseTo(bottom);
  }
);

test.each([
  { left: 44, right: 0, minLeft: 44, maxRight: 844 },
  { left: 0, right: 44, minLeft: 0, maxRight: 800 },
])('sheet input clears safe areas $left / $right', async ({ left, right, minLeft, maxRight }) => {
  document.documentElement.style.setProperty('--safe-area-inset-left', `${left}px`);
  document.documentElement.style.setProperty('--safe-area-inset-right', `${right}px`);
  const screen = await render(Harness);
  await expect.element(screen.getByRole('dialog', { name: 'Options' })).toBeVisible();

  const input = screen.getByRole('textbox', { name: 'Filter' }).element().getBoundingClientRect();
  expect(input.left).toBeGreaterThanOrEqual(minLeft);
  expect(input.right).toBeLessThanOrEqual(maxRight);
});

test.each([
  { keyboard: 0, fullHeight: false, lastBottom: 369 },
  { keyboard: 0, fullHeight: true, lastBottom: 369 },
  { keyboard: 190, fullHeight: false, lastBottom: 200 },
  { keyboard: 230, fullHeight: true, lastBottom: 160 },
])(
  'last option scrolls clear of the home indicator and $keyboard px keyboard (full height: $fullHeight)',
  async ({ keyboard, fullHeight, lastBottom }) => {
    const screen = await render(Harness, { fullHeight });
    const dialog = screen.getByRole('dialog', { name: 'Options' });
    await expect.element(dialog).toBeVisible();
    document.documentElement.style.setProperty('--keyboard-height', `${keyboard}px`);
    const body = dialog.element().querySelector('.sheet-body') as HTMLElement;
    body.scrollTop = body.scrollHeight;

    const last = screen
      .getByRole('button', { name: 'Option 12', exact: true })
      .element()
      .getBoundingClientRect();
    expect(last.top).toBeGreaterThanOrEqual(dialog.element().getBoundingClientRect().top);
    expect(last.bottom).toBeLessThanOrEqual(lastBottom);
  }
);

test('a downward swipe dismisses only once the sheet content is scrolled to its top', async () => {
  const screen = await render(Harness);
  const dialog = screen.getByRole('dialog', { name: 'Options' });
  await expect.element(dialog).toBeVisible();
  const body = dialog.element().querySelector('.sheet-body') as HTMLElement;
  const option = screen.getByRole('button', { name: 'Option 6', exact: true }).element();
  function swipeClaimed(): boolean {
    const at = (clientY: number) => [
      new Touch({ identifier: 1, target: option, clientX: 100, clientY }),
    ];
    option.dispatchEvent(new TouchEvent('touchstart', { touches: at(100), bubbles: true }));
    const move = new TouchEvent('touchmove', { touches: at(160), bubbles: true, cancelable: true });
    option.dispatchEvent(move);
    option.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true }));
    return move.defaultPrevented;
  }

  body.scrollTop = 40;
  expect(swipeClaimed()).toBe(false);

  body.scrollTop = 0;
  expect(swipeClaimed()).toBe(true);
});

test('an upward swipe grows an expandable sheet without lifting it off the bottom edge', async () => {
  const screen = await render(Harness, { expandable: true });
  const dialog = screen.getByRole('dialog', { name: 'Options' });
  await expect.element(dialog).toBeVisible();
  const option = screen.getByRole('button', { name: 'Option 1', exact: true }).element();
  const at = (clientY: number) => [
    new Touch({ identifier: 1, target: option, clientX: 100, clientY }),
  ];
  const bottom = dialog.element().getBoundingClientRect().bottom;

  option.dispatchEvent(new TouchEvent('touchstart', { touches: at(300), bubbles: true }));
  option.dispatchEvent(
    new TouchEvent('touchmove', { touches: at(-400), bubbles: true, cancelable: true })
  );
  await expect.poll(() => dialog.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(dialog.element().getBoundingClientRect().bottom).toBeCloseTo(bottom, 0);
  option.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
});
