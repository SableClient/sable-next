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

async function openSettingsSheet(page: Page) {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections).toBeVisible();
  return sections;
}

test('mobile: swiping down on the settings sheet content closes it', async ({
  page,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'touch is driven over CDP');
  await installRoomCore('ready');
  const sections = await openSettingsSheet(page);
  const box = await sections.boundingBox();
  if (!box) throw new Error('The settings sections are not laid out.');

  await swipeDown(page, box.x + box.width / 2, box.y + 40, box.y + 440);

  await expect(sections).toBeHidden();
});

test('mobile: a scrolled settings sheet scrolls back up instead of closing', async ({
  page,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'touch is driven over CDP');
  await installRoomCore('ready');
  const sections = await openSettingsSheet(page);
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
  if (!box) throw new Error('The settings sections are not laid out.');

  await swipeDown(
    page,
    box.x + box.width / 2,
    box.y + box.height / 2 - 150,
    box.y + box.height / 2 + 50
  );

  await expect(sections).toBeVisible();
});
