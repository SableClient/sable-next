// Scripted transport: the inbox reads the room list, so its rooms, unread
// counts and pending invitation all come from the fake core.

import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
});

test('lists rooms that named us, and opens one', async ({ page, app, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openInbox();

  // Scoped to the page body: the sidebar lists the same rooms.
  const inbox = page.getByRole('main');
  await expect(inbox.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(inbox.getByText('alice: General message 19').first()).toBeVisible();

  await inbox.getByRole('link', { name: /^General/ }).click();
  await expect(page).toHaveURL(/\/home\/!room%3Aexample.test$/);
});

test('filters notifications, and says so when nothing matches', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openInbox();
  const inbox = page.getByRole('main');

  await inbox.getByRole('button', { name: 'Mentions' }).click();
  await expect(page).toHaveURL(/\?filter=mentions$/);
  await expect(inbox.getByRole('link', { name: /^General/ })).toBeVisible();

  // The fixture has no direct messages.
  await inbox.getByRole('button', { name: 'Chats' }).click();
  await expect(inbox.getByText('Nothing is waiting for you.', { exact: false })).toBeVisible();
});

test('answers a pending invitation above the feed', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openInbox();

  const inbox = page.getByRole('main');
  await expect(inbox.getByRole('heading', { name: /Pending invites/ })).toBeVisible();

  const card = inbox.getByRole('listitem').filter({ hasText: 'Design crew' });
  await expect(card.getByText('Invited by ada')).toBeVisible();
  await expect(card.getByText('Where the redesign happens.')).toBeVisible();

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(() => core.commands()).toContain('join_room');
});

test('marks a room read from its row', async ({ page, app, core, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openInbox();

  const row = page.getByRole('main').getByRole('listitem').filter({ hasText: 'General' });
  await row.getByRole('button', { name: 'Mark General as read' }).click();

  await expect.poll(() => core.commands()).toContain('mark_read');
});

test('badges the inbox with what is waiting', async ({ page, app, installRoomCore }) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openHome();

  // Two rooms named us once each, and one invitation is pending.
  await expect(page.getByRole('link', { name: 'Inbox, 3 waiting' }).first()).toBeVisible();
  await expect(page.locator('a[href="/home"] .unread-count').first()).toHaveText('2');
});
