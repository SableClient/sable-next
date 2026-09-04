import { readFile } from 'node:fs/promises';
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './fixtures/loginAccount';
import { homeserverStatePath } from './fixtures/runtime';

test.use({ storageState: SIGNED_OUT });

test('signs in with a password', async ({ auth, page }) => {
  const { baseUrl } = JSON.parse(await readFile(homeserverStatePath(), 'utf8')) as {
    baseUrl: string;
  };

  await auth.open(baseUrl);
  await auth.revealPasswordLogin();
  await expect(auth.username).toBeVisible();
  await auth.signInWithPassword(LOGIN_USERNAME, LOGIN_PASSWORD);

  await expect(page).toHaveURL(/\/login\/verify$/);
  await expect(auth.verificationCard).toBeVisible();
  await page.locator('.rail').evaluate((rail) => {
    rail.scrollLeft = 0;
    rail.dispatchEvent(new Event('scroll'));
  });
  await expect(page).toHaveURL(/\/login$/);
  await expect(auth.username).toBeVisible();
  await auth.nextStageButton.click();
  await expect(page).toHaveURL(/\/login\/verify$/);
  await auth.previousStageButton.click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(auth.username).toBeVisible();
  await auth.nextStageButton.click();
  await expect(page).toHaveURL(/\/login\/verify$/);
  await auth.leaveVerificationButton.click();
  await expect(page).toHaveURL(/\/rooms$/);
});
