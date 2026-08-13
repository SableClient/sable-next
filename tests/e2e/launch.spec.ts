import { expect, test } from './fixtures/test';

test('starts at the sign-in flow', async ({ page, auth }) => {
  const workerErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /worker script/i.test(message.text())) {
      workerErrors.push(message.text());
    }
  });

  await auth.open();
  await expect(page).toHaveURL(/\/login$/);
  await expect(auth.heading).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter))
    .toBe('auto');
  expect(workerErrors).toEqual([]);
});
