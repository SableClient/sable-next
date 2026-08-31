import type { Page } from '@playwright/test';
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

function fields(page: Page) {
  return {
    input: page.getByLabel('Add a keyword'),
    add: page.locator('.keyword-form').getByRole('button', { name: 'Add', exact: true }),
  };
}

function keyword(page: Page, text: string) {
  return page.locator('.keyword-list li').filter({ hasText: text });
}

function removeButton(page: Page, text: string) {
  return page.getByRole('button', { name: `Remove keyword ${text}` });
}

test.describe('against the homeserver', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings/notifications');
    await expect(page.getByLabel('Add a keyword')).toBeVisible();
  });

  test('adding a keyword writes a push rule and lists it', async ({ admin, page }) => {
    const { input, add } = fields(page);
    const word = `urgent${String(Date.now())}`;

    await expect(page.getByText('No keywords yet.')).toBeVisible();

    await input.fill(word);
    await add.click();

    await expect(keyword(page, word)).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(page.getByText('No keywords yet.')).toHaveCount(0);

    await expect
      .poll(() =>
        admin.pushRules().then((rules) => (rules.global.content ?? []).map((r) => r.rule_id))
      )
      .toContain(word);
  });

  test('a blank keyword cannot be added', async ({ page }) => {
    await expect(fields(page).add).toBeDisabled();
  });

  test('a duplicate keyword cannot be added', async ({ page }) => {
    const { input, add } = fields(page);
    const word = `dupe${String(Date.now())}`;

    await input.fill(word);
    await add.click();
    await expect(keyword(page, word)).toBeVisible();

    await input.fill(word);
    await expect(add).toBeDisabled();
  });

  test('removing a keyword drops it and its push rule', async ({ admin, page }) => {
    const { input, add } = fields(page);
    const word = `drop${String(Date.now())}`;

    await input.fill(word);
    await add.click();
    await expect(keyword(page, word)).toBeVisible();

    await removeButton(page, word).click();

    await expect(keyword(page, word)).toHaveCount(0);
    await expect
      .poll(() =>
        admin.pushRules().then((rules) => (rules.global.content ?? []).map((r) => r.rule_id))
      )
      .not.toContain(word);
  });
});

test.describe('when the server refuses', () => {
  test.use({ storageState: SIGNED_OUT });

  test.beforeEach(async ({ page, proxiedLogin }) => {
    await proxiedLogin();
    await page.goto('/settings/notifications');
    await expect(page.getByLabel('Add a keyword')).toBeVisible();
  });

  test('a failure adding a keyword leaves the list showing what the server has', async ({
    page,
    homeserverProxy,
  }) => {
    const { input, add } = fields(page);
    const word = `refused${String(Date.now())}`;
    homeserverProxy.fail(new RegExp(`PUT /_matrix/client/v3/pushrules/global/content/${word}`));

    await input.fill(word);
    await add.click();

    await expect(page.getByText('That keyword could not be added.')).toBeVisible();
    await expect(keyword(page, word)).toHaveCount(0);
  });

  test('a failure removing a keyword leaves it in the list', async ({ page, homeserverProxy }) => {
    const { input, add } = fields(page);
    const word = `stuck${String(Date.now())}`;

    await input.fill(word);
    await add.click();
    await expect(keyword(page, word)).toBeVisible();

    homeserverProxy.fail(new RegExp(`DELETE /_matrix/client/v3/pushrules/global/content/${word}`));
    await removeButton(page, word).click();

    await expect(page.getByText('That keyword could not be removed.')).toBeVisible();
    await expect(keyword(page, word)).toBeVisible();
  });
});
