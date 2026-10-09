import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test';

// The headless shell has no notification platform and crashes on
// showNotification; Chrome's own headless mode has one.
test.use({ channel: 'chromium' });

test.beforeEach(async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

async function shownNotifications(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    const notifications = await ready.getNotifications();
    return notifications.map((notification) => {
      const shown = `${notification.title}|${notification.body}|${notification.tag}`;
      notification.close();
      return shown;
    });
  });
}

async function shownActions(page: Page): Promise<string[][]> {
  return page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    const notifications = await ready.getNotifications();
    return notifications.map((notification) => {
      const titles = (notification as Notification & { actions: { title: string }[] }).actions.map(
        (action) => action.title
      );
      notification.close();
      return titles;
    });
  });
}

test('a push shows a notification naming the room the app cached', async ({
  page,
  app,
  context,
  admin,
}) => {
  await context.grantPermissions(['notifications']);

  const roomName = `Pushed ${String(Date.now())}`;
  const roomId = await admin.createRoom({ name: roomName });
  const eventId = await admin.sendMessage(roomId, 'A message worth pushing.');

  await app.openRooms();
  await expect(app.roomLink(roomName)).toBeVisible({ timeout: 30_000 });

  const session = await context.newCDPSession(page);
  const activated = new Promise<string>((resolve) => {
    session.on('ServiceWorker.workerVersionUpdated', (event) => {
      const running = event.versions.find((version) => version.status === 'activated');
      if (running) resolve(running.registrationId);
    });
  });
  await session.send('ServiceWorker.enable');
  const registrationId = await activated;

  const payload = JSON.stringify({
    notification: {
      room_id: roomId,
      event_id: eventId,
      user_id: admin.userId,
      counts: { unread: 3 },
    },
  });

  // Delivered on every attempt: the room names the worker reads are written when
  // the list arrives, and a push landing before that would say "Sable".
  const deliver = async (): Promise<string[]> => {
    await session.send('ServiceWorker.deliverPushMessage', {
      origin: 'http://127.0.0.1',
      registrationId,
      data: payload,
    });
    return shownNotifications(page);
  };

  const away = await context.newPage();
  await away.bringToFront();

  await expect
    .poll(deliver, { timeout: 30_000 })
    .toEqual([`Sable|New message|${admin.userId} ${roomId}`]);
  await expect
    .poll(deliver, { timeout: 60_000 })
    .toEqual([`${roomName}|New message|${admin.userId} ${roomId}`]);
  await away.close();
});

test('a push for an invitation reads as an invitation with accept and decline', async ({
  page,
  app,
  context,
  admin,
  guest,
}) => {
  await context.grantPermissions(['notifications']);

  const roomName = `Invited ${String(Date.now())}`;
  const roomId = await guest.createRoom({ name: roomName, invite: [admin.userId] });

  await app.openRooms();

  const session = await context.newCDPSession(page);
  const activated = new Promise<string>((resolve) => {
    session.on('ServiceWorker.workerVersionUpdated', (event) => {
      const running = event.versions.find((version) => version.status === 'activated');
      if (running) resolve(running.registrationId);
    });
  });
  await session.send('ServiceWorker.enable');
  const registrationId = await activated;

  const payload = JSON.stringify({
    notification: {
      room_id: roomId,
      event_id: '$an-invite',
      user_id: admin.userId,
      type: 'm.room.member',
      membership: 'invite',
      sender_display_name: 'Ada',
      counts: { unread: 1 },
    },
  });

  const away = await context.newPage();
  await away.bringToFront();

  const deliver = async (): Promise<string[]> => {
    await session.send('ServiceWorker.deliverPushMessage', {
      origin: 'http://127.0.0.1',
      registrationId,
      data: payload,
    });
    const bodies = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return (await ready.getNotifications()).map((notification) => notification.body);
    });
    return bodies;
  };

  await expect.poll(deliver, { timeout: 60_000 }).toEqual([expect.stringMatching(/invited you/i)]);
  expect(await shownActions(page)).toEqual([['Accept', 'Decline']]);
  await away.close();
});
