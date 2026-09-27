import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

function storedTextScale(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as {
      textScale?: number;
    };
    return stored.textScale;
  });
}

test('a size setting takes a typed percentage and clamps it', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/settings/accessibility');
  const field = page.getByRole('spinbutton', { name: 'Text size in percent' });

  await field.fill('120');
  await field.press('Enter');
  await expect.poll(() => storedTextScale(page)).toBe(1.2);

  await field.fill('900');
  await field.press('Enter');
  await expect(field).toHaveValue('150');
  await expect.poll(() => storedTextScale(page)).toBe(1.5);
});
