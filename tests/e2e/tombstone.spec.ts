import { expect, test } from './fixtures/test';

test('a tombstoned room replaces the composer with a banner offering the successor', async ({
  page,
  app,
  admin,
  guest,
}) => {
  test.setTimeout(60_000);

  const roomId = await guest.createRoom({
    name: `Old Room ${String(Date.now())}`,
    invite: [admin.userId],
  });
  await admin.join(roomId);
  await guest.sendMessage(roomId, 'The room moved.');
  const successorId = await guest.upgradeRoom(roomId);
  await guest.invite(successorId, admin.userId);

  await app.openRoom(roomId, { settled: false });

  await expect(page.getByRole('region', { name: 'This room has been replaced' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('combobox', { name: 'Send a message...' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Join new room' }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(successorId).replace(/\$/g, '\\$')), {
    timeout: 20_000,
  });
});
