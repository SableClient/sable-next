import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, installRoomCore }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('ready');
});

for (const activation of ['click', 'Enter'] as const) {
  test(`opening a room with ${activation} focuses its message field`, async ({ app, page }) => {
    await app.openRooms();
    const room = app.roomLink('General');
    if (activation === 'click') await room.click();
    else {
      await room.focus();
      await room.press('Enter');
    }

    await expect(app.composer).toBeFocused();
    await page.keyboard.type('Hello');
    await expect(app.composer).toHaveText('Hello');

    await app.roomLink('Random').click();
    await expect(page).toHaveURL(/\/rooms\/!second%3Aexample.test$/);
    await expect(app.composer).toHaveCount(0);
    await app.roomLink('General').click();
    await expect(app.composer).toBeFocused();
    await expect(app.composer).toHaveText('Hello');
  });
}

test('Alt+Shift+Up and Down switch unread rooms from the message field', async ({ app, page }) => {
  await app.openRooms();
  await app.roomLink('General').click();
  await expect(app.composer).toBeFocused();

  await page.keyboard.press('Alt+Shift+ArrowDown');
  await expect(page).toHaveURL(/\/rooms\/!second%3Aexample.test$/);
  await expect(app.composer).toHaveCount(0);

  await page.keyboard.press('Alt+Shift+ArrowUp');
  await expect(page).toHaveURL(/\/rooms\/!room%3Aexample.test$/);
  await expect(app.composer).toBeVisible();
});

test('mobile: opening a room leaves the message field unfocused', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.openRooms();
  await app.roomLink('General').click();

  await expect(app.composer).toBeVisible();
  await expect(app.composer).not.toBeFocused();
});
