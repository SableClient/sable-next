import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/test';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './fixtures/loginAccount';
import { homeserverStatePath } from './fixtures/runtime';

test('signs in through the OIDC redirect flow', async ({ auth, page }) => {
  const { baseUrl } = JSON.parse(await readFile(homeserverStatePath(), 'utf8')) as {
    baseUrl: string;
  };

  await auth.open(baseUrl);
  await auth.revealMoreMethods();

  const popup = page.waitForEvent('popup');
  await auth.redirectSignInButton.click();
  const provider = await popup;
  await provider.locator('#identifier').fill(LOGIN_USERNAME);
  await provider.locator('#password').fill(LOGIN_PASSWORD);
  await provider.getByRole('button', { name: 'Log in' }).click();
  await provider.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/login\/verify$/);
  await expect(auth.verificationCard).toBeVisible();

  // `/login/verify` once had its path segment read back as the homeserver.
  await auth.previousStageButton.click();
  await expect(auth.homeserver).toHaveValue(baseUrl);

  await auth.nextStageButton.click();
  await auth.leaveVerification();
  await expect(page).toHaveURL(/\/home$/);

  await page.reload();
  await expect(page).toHaveURL(/\/home$/);
});
