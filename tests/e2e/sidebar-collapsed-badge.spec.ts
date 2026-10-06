import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('collapsed room rows keep their unread badges inside the row', async ({
  page,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('sable-room-navigation-width', '50');
  });
  await installRoomCore('unread');
  await page.goto('/rooms/!room%3Aexample.test');

  const badges = page.locator('.room-list.collapsed .room-row .unread-badge');
  await expect(badges.first()).toBeVisible({ timeout: 30_000 });

  const outside = await badges.evaluateAll(
    (elements) =>
      elements.filter((badge) => {
        const wrap = badge.closest('.room-row-wrap')?.getBoundingClientRect();
        const box = badge.getBoundingClientRect();
        return !wrap || box.left < wrap.left || box.right > wrap.right || box.top < wrap.top;
      }).length
  );
  expect(outside).toBe(0);
});
