import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

async function swipeDown(page: Page, x: number, fromY: number, toY: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', fromY);
  for (let y = fromY + 20; y <= toY; y += 20) await touch('touchMove', y);
  await touch('touchEnd', toY);
}

async function openJumpSheet(page: Page) {
  await page.goto('/settings/notifications');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const sections = page.getByRole('dialog', { name: 'On this page: Notifications' });
  await expect(sections.getByRole('list')).toBeVisible();
  return sections.getByRole('list');
}

test('mobile: swiping down on the sheet content closes it', async ({
  page,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'touch is driven over CDP');
  await installRoomCore('ready');
  const sections = await openJumpSheet(page);
  const box = await sections.boundingBox();
  if (!box) throw new Error('The sheet list is not laid out.');

  await swipeDown(page, box.x + box.width / 2, box.y + 40, box.y + 440);

  await expect(sections).toBeHidden();
});

test('mobile: a scrolled sheet scrolls back up instead of closing', async ({
  page,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'touch is driven over CDP');
  await page.setViewportSize({ width: 412, height: 420 });
  await installRoomCore('ready');
  const sections = await openJumpSheet(page);
  const scrolled = await sections.evaluate((node) => {
    for (let element: Element | null = node; element; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1) {
        element.scrollTop = 200;
        if (element.scrollTop > 0) return true;
      }
    }
    return false;
  });
  expect(scrolled).toBe(true);
  const box = await sections.boundingBox();
  if (!box) throw new Error('The sheet list is not laid out.');

  await swipeDown(
    page,
    box.x + box.width / 2,
    box.y + box.height / 2 - 150,
    box.y + box.height / 2 + 50
  );

  await expect(sections).toBeVisible();
});

test.describe('with motion', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('mobile: the sheet follows the finger all the way and slides out when let go', async ({
    page,
    installRoomCore,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'touch is driven over CDP');
    await installRoomCore('ready');
    const sections = await openJumpSheet(page);
    const sheet = page.locator('.dialog-content-sheet');
    await page.waitForTimeout(500);
    const before = await sheet.boundingBox();
    const box = await sections.boundingBox();
    if (!before || !box) throw new Error('The sheet is not laid out.');

    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const fromY = before.y + 80;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      });
    const travel = Math.min(before.height * 0.8, 880 - fromY);
    await touch('touchStart', fromY);
    for (let y = fromY + 20; y <= fromY + travel; y += 20) await touch('touchMove', y);

    const dragged = await sheet.boundingBox();
    if (!dragged) throw new Error('The sheet vanished mid-drag.');
    expect(dragged.y - before.y).toBeGreaterThan(travel - 30);

    await touch('touchEnd', fromY + travel);
    await expect
      .poll(async () => (await sheet.boundingBox())?.y ?? Infinity)
      .toBeGreaterThan(dragged.y);
    await expect(sections).toBeHidden();
  });
});
