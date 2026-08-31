import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('bookmarking a message surfaces it in the inbox and opens the event', async ({
  page,
  app,
  admin,
}) => {
  const roomName = `Bookmarks ${String(Date.now())}`;
  const roomId = await admin.createRoom({ name: roomName });
  const body = `Worth keeping ${String(Date.now())}`;
  const eventId = await admin.sendMessage(roomId, body);

  await app.openRoom(roomId);

  await page.locator('.timeline-viewport').getByText(body, { exact: true }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: 'Bookmark' }).click();

  await app.openInbox();
  const bookmarks = page.getByRole('region', { name: 'Bookmarks' });
  const row = bookmarks.getByRole('listitem').filter({ hasText: roomName });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText(body)).toBeVisible();

  await row.getByRole('link').click();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(encodeURIComponent(roomId)));
  await expect.poll(() => new URL(page.url()).searchParams.get('event')).toBe(eventId);
});

test('removing a bookmark from the inbox takes it out of the list', async ({
  page,
  app,
  admin,
}) => {
  const roomName = `Unbookmark ${String(Date.now())}`;
  const roomId = await admin.createRoom({ name: roomName });
  const body = `Not worth keeping ${String(Date.now())}`;
  await admin.sendMessage(roomId, body);

  await app.openRoom(roomId);

  await page.locator('.timeline-viewport').getByText(body, { exact: true }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: 'Bookmark' }).click();

  await app.openInbox();
  const bookmarks = page.getByRole('region', { name: 'Bookmarks' });
  const row = bookmarks.getByRole('listitem').filter({ hasText: roomName });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.getByRole('button', { name: /Remove bookmark/ }).click();

  await expect(row).toHaveCount(0);
});
