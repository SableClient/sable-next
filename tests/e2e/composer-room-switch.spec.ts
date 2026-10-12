import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('the composer keeps one draft per room across an in-app switch', async ({
  app,
  bootstrap,
  scratchRoom,
  signIn,
}) => {
  const otherName = `Elsewhere ${String(Date.now())}`;
  const otherId = await bootstrap.createRoom({ name: otherName });
  await bootstrap.sendMessage(otherId, 'Other room opened');

  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await app.composer.fill('draft in first');

  await app.openRoomFromList(otherName);
  await expect(app.composer).toHaveText('');
  await app.composer.fill('draft in second');

  await app.openRoomFromList(scratchRoom.name);
  await expect(app.composer).toHaveText('draft in first');

  await app.composer.press('ControlOrMeta+z');
  await app.openRoomFromList(otherName);
  await expect(app.composer).toHaveText('draft in second');
});

test('undo after a room switch does not bring back the previous room text', async ({
  app,
  bootstrap,
  scratchRoom,
  signIn,
}) => {
  const otherName = `Elsewhere ${String(Date.now())}`;
  const otherId = await bootstrap.createRoom({ name: otherName });
  await bootstrap.sendMessage(otherId, 'Other room opened');

  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await app.composer.fill('only in first');

  await app.openRoomFromList(otherName);
  await expect(app.composer).toHaveText('');
  await app.composer.click();
  await app.composer.press('ControlOrMeta+z');
  await expect(app.composer).toHaveText('');
});
