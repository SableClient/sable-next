import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('a voice room keeps the lobby in view and opens its chat beside it', async ({
  page,
  app,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installRoomCore('voice');
  await app.openRoom('!voice:example.test', { settled: false });
  const toggle = page.getByRole('button', { name: 'Show chat' });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const chat = page.getByRole('complementary', { name: 'Chat' });
  await expect(chat).toBeVisible();
  await expect(chat.locator('.composer-dock')).toBeVisible();
  await expect(page.locator('.timeline .composer-dock')).toHaveCount(0);

  await page.getByRole('button', { name: 'Hide chat' }).click();
  await expect(chat).toBeHidden();
});

test('mobile: a voice room swaps the lobby for its chat', async ({
  page,
  app,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 412, height: 900 });
  await installRoomCore('voice');
  await app.openRoom('!voice:example.test', { settled: false });
  await page.getByRole('button', { name: 'Show chat' }).click();

  await expect(page.locator('.timeline .composer-dock')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Chat' })).toHaveCount(0);
});
