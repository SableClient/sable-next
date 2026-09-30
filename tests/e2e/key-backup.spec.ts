import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('cloud backup counts, manual restore, and settings layout', async ({
  page,
  installRoomCore,
}, testInfo) => {
  await installRoomCore('ready');
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: 'Cloud key backup' })).toBeVisible({
    timeout: 20_000,
  });
  const backup = page.getByRole('region', { name: 'Cloud key backup' });
  await expect(backup.getByText('200 keys in the cloud')).toBeVisible();
  await expect(backup.getByText('120 keys on this device')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('backup-status.png'), fullPage: true });
  await backup.getByRole('button', { name: 'Download keys' }).click();
  await expect(backup.getByText('Restored 200 of 200 keys.')).toBeVisible();
  await expect(backup.getByText('80 keys added or updated on this device.')).toBeVisible();
  await expect(backup.getByText('200 keys on this device')).toBeVisible();
  expect(await backup.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('backup-restored.png'), fullPage: true });
});
