import { expect, test } from './fixtures/test';

test('a room this account cannot post in offers an empty box, not a composer', async ({
  page,
  app,
  admin,
  guest,
}) => {
  const writableName = `Writable ${String(Date.now())}`;
  const writableId = await admin.createRoom({ name: writableName });
  await admin.sendMessage(writableId, 'Anyone here can post.');

  const readOnlyName = `Read only ${String(Date.now())}`;
  const readOnlyId = await guest.createRoom({
    name: readOnlyName,
    invite: [admin.userId],
    powerLevels: { events_default: 50, users: { [guest.userId]: 100 } },
  });
  await guest.sendMessage(readOnlyId, 'Only moderators post here.');
  await admin.join(readOnlyId);

  await app.openRoom(writableId);
  const writable = await page.locator('.composer').boundingBox();

  await app.openRoom(readOnlyId);
  await expect(page.locator('.composer .locked')).toHaveText(
    'You do not have permission to post in this room'
  );
  const readOnly = await page.locator('.composer').boundingBox();

  await expect(page.locator('.composer button')).toHaveCount(0);
  await expect(page.locator('[role="combobox"]')).toHaveCount(0);
  expect(readOnly?.height).toBe(writable?.height);
});
