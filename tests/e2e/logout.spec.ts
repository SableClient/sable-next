import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const ROOM_ID = '!room:example.test';

test('signing out reaches the sign-in page without a render failure', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  const unhandled: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('unhandled error')) {
      unhandled.push(message.text());
    }
  });
  await app.openRoom(ROOM_ID);

  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Log out' }).click();

  await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  await expect(page.getByRole('combobox', { name: 'Account provider' })).toBeVisible();
  expect(unhandled).toEqual([]);
});
