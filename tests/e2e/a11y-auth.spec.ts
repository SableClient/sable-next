import en from '../../src/locales/en.json' with { type: 'json' };
import { violations } from './fixtures/a11y';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './fixtures/loginAccount';
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('sign-in has no stage navigation landmark and a described create-account prompt', async ({
  auth,
  homeserver,
  page,
}) => {
  await auth.open(homeserver.baseUrl);
  await expect(auth.moreMethodsButton).toBeVisible({ timeout: 60_000 });

  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.locator('.mobile-nav')).toHaveCount(1);
  await expect(page.getByText(en.auth.noAccountYet)).toBeVisible();
  await expect(
    page.getByRole('button', { name: en.auth.createAccount })
  ).toHaveAccessibleDescription(en.auth.noAccountYet);
});

test('Tab reaches the sign-in form before the stage buttons', async ({
  auth,
  homeserver,
  page,
}) => {
  await auth.open(homeserver.baseUrl);
  await expect(auth.moreMethodsButton).toBeVisible({ timeout: 60_000 });

  await expect(page.getByRole('heading', { name: en.auth.signInTitle, exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(auth.homeserver).toBeFocused();

  const order: string[] = [];
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab');
    order.push(
      await page.evaluate(
        () =>
          document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.textContent.trim() ??
          ''
      )
    );
  }
  expect(order.indexOf(en.auth.next), order.join(' | ')).toBeGreaterThan(
    order.indexOf(en.auth.moreWaysToSignIn)
  );
});

test('setup exposes only the current step and has no violations', async ({
  auth,
  homeserver,
  page,
}) => {
  await auth.open(homeserver.baseUrl);
  await auth.revealPasswordLogin();
  await auth.signInWithPassword(LOGIN_USERNAME, LOGIN_PASSWORD);
  await expect(page).toHaveURL(/\/setup\/[a-z]+$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await expect(page.locator('.auth-card.muted').getByRole('button')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test('provider validation gates Next and preserves focus', async ({
  auth,
  homeserverProxy,
  page,
}) => {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        homeserverList: [homeserverProxy.baseUrl],
        defaultHomeserver: null,
        allowCustomHomeservers: true,
      },
    })
  );
  homeserverProxy.delay(/\/_matrix\/client\/(?:v3|r0)\/login/, 1500);
  await auth.open();
  await expect(page.getByRole('heading', { name: en.auth.signInTitle, exact: true })).toBeFocused();
  await expect(auth.nextStageButton).toHaveCount(0);
  await expect(page.getByRole('button', { name: en.auth.continue, exact: true })).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(auth.homeserver).toBeFocused();

  await auth.homeserver.fill(homeserverProxy.baseUrl);
  await expect(
    page.getByRole('status').filter({ hasText: en.auth.checkingProvider })
  ).toBeVisible();
  await expect(auth.nextStageButton).toHaveCount(0);
  await expect(auth.homeserver).toBeFocused();
  await expect(auth.moreMethodsButton).toBeVisible({ timeout: 60_000 });
  await expect(auth.homeserver).toBeFocused();
  await expect(auth.nextStageButton).toBeVisible();

  await auth.nextStageButton.click();
  await expect(
    page.getByRole('heading', { name: en.auth.createAccount, exact: true })
  ).toBeFocused();
  await auth.previousStageButton.click();
  await expect(page.getByRole('heading', { name: en.auth.signInTitle, exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(auth.homeserver).toBeFocused();
});
