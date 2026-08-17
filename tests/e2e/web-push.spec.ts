// Drives a real push through the browser: Chrome delivers it to the built
// service worker, which is the only way to exercise that file end to end.

import { expect, test } from './fixtures/test';

// The headless shell has no notification platform and crashes on
// showNotification; Chrome's own headless mode has one.
test.use({ channel: 'chromium' });

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

async function shownNotifications(page: import('@playwright/test').Page): Promise<string[]> {
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
  installRoomCore,
}) => {
  await context.grantPermissions(['notifications']);
  await installRoomCore('ready');
  await app.openHome();

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
      room_id: '!room:example.test',
      event_id: '$general-19:example.test',
      user_id: '@e2e:example.test',
      counts: { unread: 3 },
    },
  });

  // Delivered on every attempt: the room names the worker reads are written when
  // the list arrives, and a push landing before that would say "Sable".
  await expect
    .poll(
      async () => {
        await session.send('ServiceWorker.deliverPushMessage', {
          origin: 'http://127.0.0.1',
          registrationId,
          data: payload,
        });
        return shownNotifications(page);
      },
      { timeout: 20_000 }
    )
    .toEqual(['General|New message|@e2e:example.test !room:example.test']);
});
