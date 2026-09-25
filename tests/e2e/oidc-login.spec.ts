import { readFile } from 'node:fs/promises';
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './fixtures/loginAccount';
import { homeserverStatePath } from './fixtures/runtime';

test.use({ storageState: SIGNED_OUT });

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

  await expect(page).toHaveURL(/\/(setup\/[a-z]+|rooms)$/);
  await auth.finishSetup();

  await page.reload();
  await expect(page).toHaveURL(/\/rooms$/);
});
