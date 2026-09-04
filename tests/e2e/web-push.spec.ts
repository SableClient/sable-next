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

  await expect
    .poll(deliver, { timeout: 30_000 })
    .toEqual([`Sable|New message|${admin.userId} ${roomId}`]);
  await expect
    .poll(deliver, { timeout: 60_000 })
    .toEqual([`${roomName}|New message|${admin.userId} ${roomId}`]);
});
