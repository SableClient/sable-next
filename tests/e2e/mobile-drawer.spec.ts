import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({
  storageState: SIGNED_OUT,
  hasTouch: true,
  viewport: { width: 412, height: 915 },
  contextOptions: { reducedMotion: 'no-preference' },
});

function trackOffsets(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const track = document.querySelector('.drawer-track');
        const offsets: number[] = [];
        const started = performance.now();
        const sample = () => {
          if (track) offsets.push(new DOMMatrix(getComputedStyle(track).transform).m41);
          if (performance.now() - started < 600) requestAnimationFrame(sample);
          else resolve(offsets);
        };
        requestAnimationFrame(sample);
      })
  );
}

async function swipe(page: Page, fromX: number, toX: number) {
  const cdp = await page.context().newCDPSession(page);
  const y = 500;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: fromX, y }],
  });
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: fromX + ((toX - fromX) * step) / 10, y }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('mobile: the room back arrow slides the list over the room, and a swipe returns to it', async ({
  app,
  page,
  installRoomCore,
  browserName,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const roomUrl = page.url();
  const drawer = page.locator('#drawer-toggle');
  await expect(drawer).toHaveAttribute('aria-pressed', 'false');

  const sampling = trackOffsets(page);
  await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
  const offsets = await sampling;

  await expect(drawer).toHaveAttribute('aria-pressed', 'true');
  expect(page.url()).toBe(roomUrl);
  const width = page.viewportSize()?.width ?? 0;
  expect(offsets.some((offset) => offset < -1 && offset > -width + 1)).toBe(true);
  expect(offsets.at(-1)).toBe(0);

  if (browserName === 'chromium') {
    await swipe(page, 350, 50);
    await expect(drawer).toHaveAttribute('aria-pressed', 'false');
    expect(page.url()).toBe(roomUrl);
  }
});

test('mobile: a tab away from the room list jumps rather than sliding the list off', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/rooms');
  const messages = page.locator('.navigation-panel .mobile-tools a[href="/rooms"]');
  await expect(messages).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });

  const sampling = trackOffsets(page);
  await page.locator('.navigation-panel .mobile-tools a[href="/navigate"]').click();
  const offsets = await sampling;

  await expect(page).toHaveURL(/\/navigate$/);
  const width = page.viewportSize()?.width ?? 0;
  expect(offsets.filter((offset) => offset < -1 && offset > -width + 1)).toEqual([]);
});

test('mobile: the messages tab stays current on every room list', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/direct');
  await expect(page.locator('.navigation-panel .mobile-tools a[href="/rooms"]')).toHaveAttribute(
    'aria-current',
    'page',
    { timeout: 30_000 }
  );
  await expect(
    page.locator('.navigation-panel .mobile-tools a[href="/navigate"]')
  ).not.toHaveAttribute('aria-current', 'page');
});
