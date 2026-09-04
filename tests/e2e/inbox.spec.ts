import { expect, test, GUEST_DISPLAY_NAME, SIGNED_OUT } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
});

test('lists rooms that named us, and opens one', async ({ page, app, admin, guest }) => {
  const roomName = `Mentioned ${String(Date.now())}`;
  const roomId = await guest.createRoom({ name: roomName, invite: [admin.userId] });
  await admin.join(roomId);
  const body = `${admin.userId}: take a look`;
  await guest.sendMessage(roomId, body, { 'm.mentions': { user_ids: [admin.userId] } });

  await app.openInbox();

  // Scoped to the page body: the sidebar lists the same rooms.
  const inbox = page.getByRole('main');
  await expect(inbox.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(inbox.getByText(body, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

  await inbox.getByRole('link', { name: new RegExp(`^${roomName}`) }).click();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(encodeURIComponent(roomId)));
});

test('filters notifications, and says so when nothing matches', async ({
  page,
  app,
  admin,
  guest,
}) => {
  const roomName = `Filtered ${String(Date.now())}`;
  const roomId = await guest.createRoom({ name: roomName, invite: [admin.userId] });
  await admin.join(roomId);
  await guest.sendMessage(roomId, `${admin.userId}: over here`, {
    'm.mentions': { user_ids: [admin.userId] },
  });

  await app.openInbox();
  const inbox = page.getByRole('main');
  const row = inbox.getByRole('link', { name: new RegExp(`^${roomName}`) });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await inbox.getByRole('button', { name: 'Mentions' }).click();
  await expect(page).toHaveURL(/\?filter=mentions$/);
  await expect(row).toBeVisible();

  await inbox.getByRole('button', { name: 'Chats' }).click();
  await expect(inbox.getByText('Nothing is waiting for you.', { exact: false })).toBeVisible();
});

test('answers a pending invitation above the feed', async ({ page, app, admin, guest }) => {
  const roomName = `Design crew ${String(Date.now())}`;
  const roomId = await guest.createRoom({
    name: roomName,
    topic: 'Where the redesign happens.',
    invite: [admin.userId],
  });

  await app.openInbox();

  const inbox = page.getByRole('main');
  await expect(inbox.getByRole('heading', { name: /Pending invites/ })).toBeVisible({
    timeout: 15_000,
  });

  const card = inbox.getByRole('listitem').filter({ hasText: roomName });
  await expect(
    card.getByText(new RegExp(`Invited by (${GUEST_DISPLAY_NAME}|guest-|@guest-)`))
  ).toBeVisible();
  await expect(card.getByText('Where the redesign happens.')).toBeVisible();

  await card.getByRole('button', { name: 'Accept' }).click();

  await expect
    .poll(() => admin.request<{ joined_rooms: string[] }>('GET', 'client/v3/joined_rooms'), {
      timeout: 15_000,
    })
    .toEqual(expect.objectContaining({ joined_rooms: expect.arrayContaining([roomId]) }));
});

test('marks a room read from its row', async ({ page, app, admin, guest }) => {
  const roomName = `Unread ${String(Date.now())}`;
  const roomId = await guest.createRoom({ name: roomName, invite: [admin.userId] });
  await admin.join(roomId);
  await guest.sendMessage(roomId, `${admin.userId}: unread please`, {
    'm.mentions': { user_ids: [admin.userId] },
  });

  await app.openInbox();
  const row = page.getByRole('main').getByRole('listitem').filter({ hasText: roomName });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.getByRole('button', { name: `Mark ${roomName} as read` }).click();

  await expect(row).toHaveCount(0);
});

test.describe('on a pristine account', () => {
  test.use({ storageState: SIGNED_OUT });

  test('badges the inbox with what is waiting', async ({ page, app, freshLogin, guest }) => {
    const account = await freshLogin();

    const mentioned = await guest.createRoom({
      name: `Badge mention ${String(Date.now())}`,
      invite: [account.userId],
    });
    await account.join(mentioned);
    await guest.sendMessage(mentioned, `${account.userId}: ping`, {
      'm.mentions': { user_ids: [account.userId] },
    });
    await guest.createRoom({
      name: `Badge invite ${String(Date.now())}`,
      invite: [account.userId],
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await app.openRooms();

    await expect(page.getByRole('link', { name: 'Inbox, 2 waiting' }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('a[href="/rooms"] .sable-unread-badge-count').first()).toHaveText(
      '1'
    );
  });
});
