import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('the lobby of a space we are not in offers to join instead of loading forever', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  await page.goto(`/space/${encodeURIComponent('!elsewhere:example.test')}/lobby`);

  await expect(page.getByRole('button', { name: 'Join' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Lobby' })).toHaveCount(0);
});
