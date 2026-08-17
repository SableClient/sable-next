import { expect, test } from './fixtures/test';

type Raised = { title: string; body: string; tag: string };

declare global {
  interface Window {
    __e2eNotifications: Raised[];
  }
}

async function stubNotifications(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const raised: Raised[] = [];
    Object.defineProperty(window, '__e2eNotifications', { configurable: true, value: raised });

    function StubNotification(
      this: unknown,
      title: string,
      options: { body?: string; tag?: string } = {}
    ) {
      raised.push({ title, body: options.body ?? '', tag: options.tag ?? '' });
    }
    StubNotification.permission = 'granted';
    StubNotification.requestPermission = () => Promise.resolve('granted');

    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: StubNotification,
    });
  });
}

const NOTIFICATION = {
  type: 'notification',
  notification: {
    user_id: '@e2e:example.test',
    room_id: '!second:example.test',
    event_id: '$general-19:example.test',
    room_name: 'Random',
    room_avatar_url: null,
    is_direct: false,
    sender: '@alice:example.test',
    sender_name: 'Alice',
    sender_avatar_url: null,
    body: 'shipped the patch',
    mention: false,
    noisy: false,
  },
};

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubNotifications(page);
});

test('shows what the core resolved, once the reader has opted in', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await page.evaluate(() => {
    localStorage.setItem(
      'sable-preferences',
      JSON.stringify({ desktopNotifications: true, notificationContent: true })
    );
  });
  await page.reload();
  await expect(app.primaryNavigation).toBeVisible();

  await page.evaluate((event) => {
    window.__e2eEmitTimelineEvent(event);
  }, NOTIFICATION);

  await expect
    .poll(() => page.evaluate(() => window.__e2eNotifications))
    .toEqual([
      {
        title: 'Random',
        body: 'Alice: shipped the patch',
        tag: '@e2e:example.test !second:example.test',
      },
    ]);
});

test('stays quiet until the switch is on', async ({ page, app, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openHome();
  await expect(app.primaryNavigation).toBeVisible();

  await page.evaluate((event) => {
    window.__e2eEmitTimelineEvent(event);
  }, NOTIFICATION);

  await expect.poll(() => page.evaluate(() => window.__e2eNotifications)).toEqual([]);
});
