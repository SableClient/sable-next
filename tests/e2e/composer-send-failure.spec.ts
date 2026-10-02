import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('a failed send keeps the draft and retries from inside the composer', async ({
  page,
  app,
  core,
  installRoomCore,
}, testInfo) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.evaluate(() => (window.__e2eSendError = 'unavailable'));

  await app.composer.fill('still here');
  await app.composer.press('Enter');

  const alert = page.locator('.composer').getByRole('alert');
  await expect(alert).toContainText('Could not reach your homeserver');
  await expect(app.composer).toHaveText('still here');
  await page.screenshot({ path: testInfo.outputPath('composer-send-failure.png') });

  await page.evaluate(() => (window.__e2eSendError = undefined));
  await alert.getByRole('button', { name: 'Retry' }).click();

  await expect(alert).toHaveCount(0);
  await expect(app.composer).toHaveText('');
  expect((await core.commands()).filter((command) => command === 'send_message')).toHaveLength(2);
});
