import { expect, test } from './fixtures/test';
import { TIMELINE_ROOM_NAME } from './fixtures/continuwuity';

const DEEP_MESSAGE = 'Timeline message 3';

test('the background crawl makes history searchable without opening the room', async ({
  page,
  app,
  signIn,
}) => {
  test.setTimeout(180_000);
  await signIn();
  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });

  await page.goto('/search');
  const field = page.getByRole('combobox', { name: /Search messages/ });
  const hit = page.locator('.hit-body').getByText(DEEP_MESSAGE, { exact: true });

  await expect
    .poll(
      async () => {
        await field.fill('');
        await field.fill(`"${DEEP_MESSAGE}"`);
        await page.waitForTimeout(500);
        return hit.count();
      },
      { timeout: 150_000, intervals: [2_000] }
    )
    .toBeGreaterThan(0);
});
