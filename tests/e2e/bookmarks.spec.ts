import { expect, test } from './fixtures/test';

test('bookmarking a message surfaces it in the inbox and opens the event', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');

  const message = page.locator('.timeline-viewport').getByText('General message 1', {
    exact: true,
  });
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Bookmark' }).click();
  await expect.poll(() => core.commands()).toContain('set_bookmark');

  await app.openInbox();
  await app.dismissDeviceBanner();
  const bookmarks = page.getByRole('region', { name: 'Bookmarks' });
  const row = bookmarks.getByRole('listitem').filter({ hasText: 'General' });
  await expect(row).toBeVisible();
  await expect(row.getByText('General message 1')).toBeVisible();

  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/home\/!room%3Aexample\.test/);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('event'))
    .toBe('$general-1:example.test');
});

test('removing a bookmark from the inbox takes it out of the list', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');

  const message = page.locator('.timeline-viewport').getByText('General message 1', {
    exact: true,
  });
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Bookmark' }).click();

  await app.openInbox();
  await app.dismissDeviceBanner();
  const bookmarks = page.getByRole('region', { name: 'Bookmarks' });
  const row = bookmarks.getByRole('listitem').filter({ hasText: 'General' });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: /Remove bookmark/ }).click();
  await expect(bookmarks.getByText('Star a message to save it here.')).toBeVisible();
});
