import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/test';
import { installFakeCore as installRoomFakeCore } from './fake-core';

function timelineItem(id: string, body: string) {
  return {
    id,
    event_id: `$${id}:example.test`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.test',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 1_700_000_000_000,
    content: { kind: 'message', body, formatted: null, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
  };
}

function timelineMessage(id: string, sender: string, timestamp: number, body: string) {
  return { ...timelineItem(id, body), sender, sender_name: sender, timestamp };
}

async function expectTimelineAtLatest(page: Page, lastEvent: string) {
  const viewport = page.locator('.timeline-viewport .viewport');
  const lastItem = page.getByText(lastEvent, { exact: true });
  await expect(lastItem).toBeVisible();
  await expect
    .poll(() =>
      viewport.evaluate((element) => ({
        distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      }))
    )
    .toEqual({ distance: 0 });
  const [itemBox, viewportBox] = await Promise.all([
    lastItem.boundingBox(),
    viewport.boundingBox(),
  ]);
  expect(itemBox).not.toBeNull();
  expect(viewportBox).not.toBeNull();
  expect((itemBox?.y ?? 0) + (itemBox?.height ?? 0)).toBeLessThanOrEqual(
    (viewportBox?.y ?? 0) + (viewportBox?.height ?? 0) + 2
  );
  expect(itemBox?.y).toBeGreaterThanOrEqual((viewportBox?.y ?? 0) - 2);
}

test('shows the authenticated app shell on desktop', async ({ page, app, installFakeCore }) => {
  await installFakeCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openHome();

  await expect(app.primaryNavigation).toBeVisible();
  await expect(app.homeLink()).toHaveAttribute('aria-current', 'page');
  await expect(app.quickTools).toBeVisible();

  const appScrollbars = await page.evaluate(() => {
    const roomNavigation = document.querySelector('.room-nav-content');
    return {
      gutter: getComputedStyle(document.documentElement).scrollbarGutter,
      roomNavigation: roomNavigation ? getComputedStyle(roomNavigation).scrollbarWidth : null,
    };
  });
  expect(appScrollbars.gutter).toBe('auto');
  expect(appScrollbars.roomNavigation).toBe('thin');
});

test('persists the keyboard-adjusted room navigation width', async ({
  page,
  app,
  installFakeCore,
}) => {
  await installFakeCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openHome();

  const resize = page.getByRole('slider', { name: 'Resize rooms' });
  await expect(resize).toHaveAttribute('aria-valuenow', '224');
  await resize.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', '304');

  await page.reload();
  await expect(page.getByRole('slider', { name: 'Resize rooms' })).toHaveAttribute(
    'aria-valuenow',
    '304'
  );
});

test('shows the authenticated app shell on mobile', async ({ page, app, installFakeCore }) => {
  await installFakeCore('ready');
  await page.setViewportSize({ width: 390, height: 844 });
  await app.openHome();

  await expect(app.primaryNavigation).toBeVisible();
  await expect(app.homeLink()).toHaveAttribute('aria-current', 'page');
  await expect(app.quickTools).toBeVisible();
});

test('keeps mobile bottom navigation with the room list panel', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');

  const quickTools = page.getByRole('navigation', { name: 'Quick tools' });
  await expect(quickTools).toBeInViewport();
  await page.getByRole('link', { name: 'General' }).click();

  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to rooms' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__e2eCommands.filter(
          (command) => command === 'subscribe_timeline' || command === 'paginate'
        )
      )
    )
    .toEqual(['subscribe_timeline']);
  await expect(quickTools).not.toBeInViewport();

  await page.getByRole('button', { name: 'Back to rooms' }).click();
  await expect(quickTools).toBeInViewport();
});

test('opens a mobile room route without showing the room list first', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto('/home/!room%3Aexample.test');

  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Quick tools' })).not.toBeInViewport();
  await expectTimelineAtLatest(page, 'General message 19');
});

test('opens a desktop room from the list at latest', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  await expectTimelineAtLatest(page, 'General message 19');
});

test('opens a direct desktop room route at latest', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home/!room%3Aexample.test');

  await expectTimelineAtLatest(page, 'General message 19');
});

test('keeps the latest message visible when the typing indicator appears', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home/!room%3Aexample.test');
  await expectTimelineAtLatest(page, 'General message 19');

  await page.evaluate(() => {
    window.__e2eEmitTimelineEvent({
      type: 'typing',
      room_id: '!room:example.test',
      user_ids: ['@alice:example.test'],
    });
  });

  await expect(page.getByText('Alice is typing...')).toBeVisible();
  await expectTimelineAtLatest(page, 'General message 19');
});

test('opens a mobile room from the list at latest', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  await expectTimelineAtLatest(page, 'General message 19');
});

test('opens a focused permalink at its target', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home/!room%3Aexample.test/%24general-10%3Aexample.test');

  await expect(page.getByText('General message 10', { exact: true })).toBeInViewport();
});

test('anchors after a delayed initial snapshot', async ({ page }) => {
  await installRoomFakeCore(page, 'delayed_snapshot');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home/!room%3Aexample.test');

  await expectTimelineAtLatest(page, 'General message 19');
});

test('stays at latest when a delayed diff changes an overflowing snapshot height', async ({
  page,
}) => {
  await installRoomFakeCore(page, 'delayed_layout_diff');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home/!room%3Aexample.test');

  await expectTimelineAtLatest(page, `Delayed layout event ${'wraps '.repeat(80)}`);
});

test('opens the selected room after returning to the mobile room list', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home/!room%3Aexample.test');

  await page.getByRole('button', { name: 'Back to rooms' }).click();
  await page.getByRole('link', { name: 'Random' }).click();

  await expect(page.getByRole('heading', { name: 'Random' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to rooms' })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.timeline-viewport .viewport').evaluate((viewport) => {
        return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      })
    )
    .toBe(0);
});

test('subscribes once and loads initial room history', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  await expect(page.getByText('Welcome to General')).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__e2eCommands.filter(
          (command) => command === 'subscribe_timeline' || command === 'paginate'
        )
      )
    )
    .toEqual(['subscribe_timeline']);
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() =>
      window.__e2eCommands.filter(
        (command) => command === 'subscribe_timeline' || command === 'paginate'
      )
    )
  ).toEqual(['subscribe_timeline']);
});

test('anchors at latest after delayed initial history arrives', async ({ page }) => {
  await installRoomFakeCore(page, 'delayed_history');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  const viewport = page.locator('.timeline-viewport .viewport');
  await expect(page.getByText('Delayed history 0', { exact: true })).toBeVisible({
    timeout: 2_000,
  });
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBe(0);
});

test('switches the active timeline to the selected room', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.getByText('Welcome to General')).toBeVisible();
  await page.getByRole('link', { name: 'Random' }).click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__e2eCommands.filter((command) => command === 'subscribe_timeline')
      )
    )
    .toHaveLength(2);
  await expect(page.getByText('Welcome to Random')).toBeVisible();

  const staleSubscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  await page.evaluate(
    ({ subscription, item }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'push_back', value: item }],
      });
    },
    { subscription: staleSubscription, item: timelineItem('stale', 'Stale General event') }
  );
  await expect(page.getByText('Stale General event')).not.toBeVisible();
});

test('keeps a visible event fixed while history prepends', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  const viewport = page.locator('.timeline-viewport .viewport');
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBe(0);
  await expect(page.locator('.timeline-content > .loading')).toHaveCount(0);
  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  const anchor = page.locator('.timeline-viewport .item').nth(2);
  const anchorId = await anchor.getAttribute('data-item-id');
  if (!anchorId) throw new Error('missing timeline item id');
  const before = await anchor.boundingBox();
  await page.evaluate(
    ({ subscription, first, second }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [
          { op: 'insert', index: 1, value: first },
          { op: 'insert', index: 2, value: second },
          { op: 'set', index: 1, value: first },
        ],
      });
    },
    {
      subscription,
      first: timelineItem('prepended-1', 'Prepended history 1'),
      second: timelineItem('prepended-2', 'Prepended history 2'),
    }
  );
  await expect
    .poll(async () => {
      const after = await page.locator(`[data-item-id="${anchorId}"]`).boundingBox();
      return after?.y;
    })
    .toBeCloseTo(before?.y ?? 0, 0);
});

test('keeps the first loaded message fixed when it becomes a continuation', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  const viewport = page.locator('.timeline-viewport .viewport');
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBe(0);
  await expect(page.locator('.timeline-content > .loading')).toHaveCount(0);
  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  const first = page.locator('.timeline-viewport .item').nth(1);
  const firstId = await first.getAttribute('data-item-id');
  if (!firstId) throw new Error('missing first timeline item id');
  const before = await first.boundingBox();
  await page.evaluate(
    ({ subscription, value }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'insert', index: 1, value }],
      });
    },
    {
      subscription,
      value: timelineMessage(
        'predecessor',
        '@alice:example.test',
        1_700_000_000_000,
        'Earlier message'
      ),
    }
  );
  await expect
    .poll(async () => page.locator(`[data-item-id="${firstId}"]`).boundingBox())
    .not.toBeNull();
  await expect
    .poll(async () => (await page.locator(`[data-item-id="${firstId}"]`).boundingBox())?.y)
    .toBeCloseTo(before?.y ?? 0, 0);
});

test('only follows appended events while pinned at latest', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  const viewport = page.locator('.timeline-viewport .viewport');
  await viewport.evaluate((element) => {
    element.scrollTop = 200;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const before = await viewport.evaluate((element) => element.scrollTop);
  await page.evaluate(
    ({ subscription, item }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'push_back', value: item }],
      });
    },
    { subscription, item: timelineItem('reader-append', 'Reader append') }
  );
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(0);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(before);

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.evaluate(
    ({ subscription, item }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'push_back', value: item }],
      });
    },
    { subscription, item: timelineItem('pinned-append', 'Pinned append') }
  );
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBe(0);
});

test('does not resubscribe the timeline after a room refresh', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.getByText('Welcome to General')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Welcome to General')).toBeVisible();
  await expectTimelineAtLatest(page, 'General message 19');

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__e2eCommands.filter(
          (command) => command === 'subscribe_timeline' || command === 'paginate'
        )
      )
    )
    .toEqual(['subscribe_timeline']);
});

test('keeps the active timeline while crossing the layout breakpoint', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.getByText('Welcome to General')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__e2eCommands.filter(
          (command) => command === 'subscribe_timeline' || command === 'paginate'
        )
      )
    )
    .toEqual(['subscribe_timeline']);
});

test('renders a startup state while the core is restoring', async ({ app, installFakeCore }) => {
  await installFakeCore('loading');
  await app.openHome();

  await expect(app.startupStatus).toContainText('Starting Sable');
  await expect(app.startupHeading).toBeVisible();
});

test('redirects signed-out protected routes to login', async ({ page }) => {
  await page.goto('/home');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('renders a recoverable error when the core cannot start', async ({ app, installFakeCore }) => {
  await installFakeCore('error');
  await app.openHome();

  await expect(app.startupError).toContainText('Sable could not start');
  await expect(app.retryButton).toBeVisible();
});
