import { expect, test, SIGNED_OUT } from './fixtures/test';
import { nextFrames } from './fixtures/settle';

test.use({ storageState: SIGNED_OUT });

test('the row options button toggles the shared menu and returns focus', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('calendar');
  await app.openRooms();
  const wrap = page.locator('.room-row-wrap', {
    has: page.locator('.room-name', { hasText: 'General' }),
  });
  await wrap.hover();
  const trigger = wrap.getByRole('button', { name: 'Room options' });

  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await trigger.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await nextFrames(page, 20);
  await expect(page.getByRole('menu')).toHaveCount(0);

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.locator('.room-name', { hasText: 'General' }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
});
