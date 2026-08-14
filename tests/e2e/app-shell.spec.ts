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

function timelineImage(id: string) {
  return {
    ...timelineItem(id, 'History image'),
    content: {
      kind: 'image',
      body: 'History image',
      source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
      width: null,
      height: null,
    },
  };
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
  await page.setViewportSize({ width: 1280, height: 420 });
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
  await expect(page.locator('.timeline-skeleton')).toHaveCount(0);
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

test('keeps the latest message visible when the mobile viewport resizes', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto('/home/!room%3Aexample.test');
  await expectTimelineAtLatest(page, 'General message 19');

  await page.setViewportSize({ width: 390, height: 420 });
  await expectTimelineAtLatest(page, 'General message 19');

  await page.setViewportSize({ width: 390, height: 700 });
  await expectTimelineAtLatest(page, 'General message 19');
});

test('keeps the latest message visible when the composer grows', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto('/home/!room%3Aexample.test');
  await expectTimelineAtLatest(page, 'General message 19');

  await page
    .getByRole('textbox', { name: 'Send a message...' })
    .fill(Array.from({ length: 6 }, (_, index) => `Line ${String(index + 1)}`).join('\n'));

  await expectTimelineAtLatest(page, 'General message 19');
});

test('preserves the visible history position when the mobile viewport resizes', async ({
  page,
}) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto('/home/!room%3Aexample.test');
  await expectTimelineAtLatest(page, 'General message 19');

  const viewport = page.locator('.timeline-viewport .viewport');
  await viewport.hover();
  await page.mouse.wheel(0, -300);
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeGreaterThan(80);

  const anchor = page.locator('.timeline-viewport .item').filter({ visible: true }).first();
  const anchorId = await anchor.getAttribute('data-item-id');
  if (!anchorId) throw new Error('missing resize anchor item id');
  const before = await anchor.boundingBox();
  if (!before) throw new Error('missing resize anchor bounds');

  await page.setViewportSize({ width: 390, height: 320 });

  await expect
    .poll(async () => (await page.locator(`[data-item-id="${anchorId}"]`).boundingBox())?.y)
    .toBeCloseTo(before.y, 0);
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

  const skeleton = page.locator('.timeline-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(page.locator('.timeline-viewport.initial')).toBeHidden();
  await expectTimelineAtLatest(page, 'General message 19');
  await expect(skeleton).toHaveCount(0);
});

test('stays at latest when a delayed diff changes an overflowing snapshot height', async ({
  page,
}) => {
  await installRoomFakeCore(page, 'delayed_layout_diff');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home/!room%3Aexample.test');

  await expectTimelineAtLatest(page, `Delayed layout event ${'wraps '.repeat(80)}`);
});

test('stays at latest when a measured timeline item grows', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home/!room%3Aexample.test');
  await expectTimelineAtLatest(page, 'General message 19');

  await page
    .locator('.timeline-viewport .item')
    .last()
    .evaluate((item) => {
      item.style.paddingBottom = '147px';
    });

  await expectTimelineAtLatest(page, 'General message 19');
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
  await page.waitForTimeout(75);
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
  await expect(page.locator('.timeline-viewport.initial')).toHaveCount(0);

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
  const positions = await page.evaluate(
    async ({ subscription, first, second, anchorId }) => {
      const positions: number[] = [];
      const sample = (): void => {
        const anchor = document.querySelector<HTMLElement>(`[data-item-id="${anchorId}"]`);
        if (anchor) positions.push(anchor.getBoundingClientRect().top);
      };
      sample();
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [
          { op: 'insert', index: 1, value: first },
          { op: 'insert', index: 2, value: second },
          { op: 'set', index: 1, value: first },
        ],
      });
      const deadline = performance.now() + 500;
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        sample();
      }
      return positions;
    },
    {
      subscription,
      first: timelineItem('prepended-1', 'Prepended history 1'),
      second: timelineItem('prepended-2', 'Prepended history 2'),
      anchorId,
    }
  );
  expect(
    Math.max(...positions.map((position) => Math.abs(position - (before?.y ?? 0))))
  ).toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const after = await page.locator(`[data-item-id="${anchorId}"]`).boundingBox();
      return after?.y;
    })
    .toBeCloseTo(before?.y ?? 0, 0);
});

test('falls back to a surviving visible anchor when the first row is replaced', async ({
  page,
}) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.locator('.timeline-viewport.initial')).toHaveCount(0);

  const viewport = page.locator('.timeline-viewport .viewport');
  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect(page.locator('.jump-to-latest')).toBeVisible();
  await viewport.dispatchEvent('wheel', { deltaY: 1 });
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  const anchor = page.locator('.timeline-viewport .item').nth(1);
  const anchorId = await anchor.getAttribute('data-item-id');
  if (!anchorId) throw new Error('missing timeline item id');
  const before = await anchor.boundingBox();

  await page.evaluate(
    ({ subscription, first, second }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [
          { op: 'remove', index: 0 },
          { op: 'push_front', value: first },
          { op: 'push_front', value: second },
        ],
      });
    },
    {
      subscription,
      first: timelineItem('replacement-1', 'Replacement history 1'),
      second: timelineItem('replacement-2', 'Replacement history 2'),
    }
  );

  await expect
    .poll(async () => (await page.locator(`[data-item-id="${anchorId}"]`).boundingBox())?.y)
    .toBeCloseTo(before?.y ?? 0, 0);
});

test('anchors a large reset by surviving event identity', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.getByText('General message 19', { exact: true })).toBeVisible();
  await expect(page.locator('.timeline-viewport.initial')).toHaveCount(0);

  const viewport = page.locator('.timeline-viewport .viewport');
  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  const initialHistory = Array.from({ length: 20 }, (_, index) => ({
    ...timelineItem(`initial-history-${String(index)}`, `Initial history ${String(index)}`),
    sender: '@bob:example.test',
    sender_name: 'Bob',
    timestamp: 1_699_998_000_000 + index,
  }));
  await page.evaluate(
    ({ subscription, items }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: items.map((value, index) => ({ op: 'insert', index, value })),
      });
    },
    { subscription, items: initialHistory }
  );
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(300);

  const anchor = page.locator('[data-event-id="$general-0:example.test"]');
  await viewport.hover();
  await page.mouse.wheel(0, -300);
  await expect(page.locator('.jump-to-latest')).toBeVisible();
  await viewport.dispatchEvent('wheel', { deltaY: 1 });
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(anchor).toHaveCount(1);
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeGreaterThan(80);
  await page.waitForTimeout(200);

  await expect(anchor).toBeInViewport();
  const before = await anchor.boundingBox();
  if (!before) throw new Error('missing anchor event');

  const items = [
    ...Array.from({ length: 80 }, (_, index) => ({
      ...timelineItem(`history-reset-${String(index)}`, `Reset history ${String(index)}`),
      sender: '@bob:example.test',
      sender_name: 'Bob',
      timestamp: 1_699_999_000_000 + index,
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      ...timelineItem(
        `replacement-${String(index)}`,
        index === 0 ? 'Welcome to General' : `General message ${String(index)}`
      ),
      event_id: `$general-${String(index)}:example.test`,
      timestamp: 1_700_000_000_000 + index,
    })),
  ];
  await page.evaluate(
    ({ subscription, items }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'reset', values: items }],
      });
    },
    { subscription, items }
  );

  await expect
    .poll(async () => (await anchor.boundingBox())?.y, { timeout: 5_000 })
    .toBeCloseTo(before.y, 0);
});

test('keeps a visible event fixed when a prepended image loads', async ({ page }) => {
  await installRoomFakeCore(page, 'delayed_media');
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
  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  const anchor = page.locator('.timeline-viewport .item').nth(3);
  const anchorId = await anchor.getAttribute('data-item-id');
  if (!anchorId) throw new Error('missing timeline item id');
  const before = await anchor.boundingBox();

  await page.evaluate(
    ({ subscription, image }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'insert', index: 1, value: image }],
      });
    },
    { subscription, image: timelineImage('prepended-image') }
  );
  const image = page.locator('.timeline-viewport .media-image');
  await expect(image).toBeVisible();
  await expect(image.locator('img')).toHaveCount(0);
  const placeholderBounds = await image.boundingBox();
  if (!placeholderBounds) throw new Error('missing image placeholder bounds');

  await expect(image.locator('img')).toBeVisible();
  const loadedBounds = await image.boundingBox();
  if (!loadedBounds) throw new Error('missing loaded image bounds');
  expect(placeholderBounds.width).toBeCloseTo(512, 0);
  expect(loadedBounds.width).toBeCloseTo(placeholderBounds.width, 0);
  expect(loadedBounds.height).toBeCloseTo(placeholderBounds.height, 0);
  await expect
    .poll(async () => (await page.locator(`[data-item-id="${anchorId}"]`).boundingBox())?.y)
    .toBeCloseTo(before?.y ?? 0, 0);
});

test('keeps a visible event fixed while a prepend is measured during backward scroll', async ({
  page,
}) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  const viewport = page.locator('.timeline-viewport .viewport');
  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  await viewport.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 300);
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const anchor = page.locator('.timeline-viewport .item').filter({ visible: true }).nth(3);
  const anchorId = await anchor.getAttribute('data-item-id');
  if (!anchorId) throw new Error('missing prepend anchor');
  const before = await anchor.boundingBox();
  if (!before) throw new Error('missing prepend anchor bounds');

  const history = Array.from({ length: 20 }, (_, index) => ({
    ...timelineItem(
      `measured-history-${String(index)}`,
      index % 2 === 0
        ? `Measured history ${String(index)}\n${'long content '.repeat(30)}`
        : `Measured history ${String(index)}`
    ),
    sender: '@bob:example.test',
    sender_name: 'Bob',
    timestamp: 1_699_999_000_000 + index,
  }));
  await page.evaluate(
    ({ subscription, history, anchorId }) => {
      const viewport = document.querySelector<HTMLElement>('.timeline-viewport .viewport');
      if (!viewport) throw new Error('missing timeline viewport');
      const positions: number[] = [];
      const sample = (): void => {
        const anchor = document.querySelector<HTMLElement>(`[data-item-id="${anchorId}"]`);
        if (anchor) positions.push(anchor.getBoundingClientRect().y);
        if (positions.length < 20) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: history.map((value, index) => ({ op: 'insert', index, value })),
      });
      window.__e2eAnchorPositions = positions;
    },
    { subscription, history, anchorId }
  );

  await expect
    .poll(async () => (await page.locator(`[data-item-id="${anchorId}"]`).boundingBox())?.y)
    .toBeCloseTo(before.y, 0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const positions = window.__e2eAnchorPositions;
        return positions.length < 20 ? null : Math.max(...positions) - Math.min(...positions);
      })
    )
    .toBeLessThanOrEqual(2);
});

test('anchors each history page requested by separate upward gestures', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  const viewport = page.locator('.timeline-viewport .viewport');
  const firstId = await page
    .locator('.timeline-viewport .item')
    .first()
    .getAttribute('data-item-id');
  if (!firstId) throw new Error('missing first timeline item id');
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await viewport.hover();
  await page.mouse.wheel(0, -200);

  await expect
    .poll(() =>
      page.evaluate(() => window.__e2eCommands.filter((item) => item === 'paginate').length)
    )
    .toBe(1);
  await expect
    .poll(async () => page.locator(`[data-item-id="${firstId}"]`).getAttribute('data-index'))
    .toBe('1');
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => window.__e2eCommands.filter((item) => item === 'paginate').length)
  ).toBe(1);
  await expect(viewport).not.toHaveJSProperty('scrollTop', 0);

  await page.waitForTimeout(150);
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  const beforeSecondPage = await page.locator(`[data-item-id="${firstId}"]`).boundingBox();
  if (!beforeSecondPage) throw new Error('missing second-page anchor bounds');
  await page.mouse.wheel(0, -200);

  await expect
    .poll(() =>
      page.evaluate(() => window.__e2eCommands.filter((item) => item === 'paginate').length)
    )
    .toBe(2);
  await expect
    .poll(async () => page.locator(`[data-item-id="${firstId}"]`).getAttribute('data-index'))
    .toBe('2');
  await expect
    .poll(async () => (await page.locator(`[data-item-id="${firstId}"]`).boundingBox())?.y)
    .toBeCloseTo(beforeSecondPage.y, 0);
});

test('anchors delayed history inserted after a stable date divider', async ({ page }) => {
  await installRoomFakeCore(page, 'delayed_pagination');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.locator('.timeline-viewport.initial')).toHaveCount(0);

  const viewport = page.locator('.timeline-viewport .viewport');
  const anchor = page.locator('[data-event-id="$general-0:example.test"]');
  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect(page.locator('.jump-to-latest')).toBeVisible();
  await viewport.dispatchEvent('wheel', { deltaY: 1 });
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  const before = await anchor.boundingBox();
  if (!before) throw new Error('missing history anchor');

  await viewport.hover();
  await page.mouse.wheel(0, -100);
  await expect
    .poll(() =>
      page.evaluate(() => window.__e2eCommands.filter((item) => item === 'paginate').length)
    )
    .toBe(1);
  await expect.poll(async () => anchor.getAttribute('data-index'), { timeout: 3_000 }).toBe('21');
  await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(before.y, 0);
});

test('anchors delayed history from a nonzero oldest-threshold offset', async ({ page }) => {
  await installRoomFakeCore(page, 'delayed_pagination');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.locator('.timeline-viewport.initial')).toHaveCount(0);

  const viewport = page.locator('.timeline-viewport .viewport');
  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect(page.locator('.jump-to-latest')).toBeVisible();
  await viewport.dispatchEvent('wheel', { deltaY: 1 });
  const thresholdItem = page.locator('[data-index="8"]');
  const thresholdStart = await thresholdItem.evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    return transform === 'none' ? 0 : new DOMMatrix(transform).m42;
  });
  await viewport.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, thresholdStart);
  const anchor = page.locator('[data-event-id="$general-8:example.test"]');
  const beforePrepend = await anchor.boundingBox();
  if (!beforePrepend) throw new Error('missing nonzero history anchor');

  await viewport.dispatchEvent('wheel', { deltaY: -100 });
  await expect
    .poll(() =>
      page.evaluate(() => window.__e2eCommands.filter((item) => item === 'paginate').length)
    )
    .toBe(1);
  await expect.poll(async () => anchor.getAttribute('data-index'), { timeout: 3_000 }).toBe('29');
  await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(beforePrepend.y, 0);
});

test('prefetches history within the oldest timeline items', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();

  const viewport = page.locator('.timeline-viewport .viewport');
  const target = page.locator('[data-index="8"]');
  const targetStart = await target.evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    return transform === 'none' ? 0 : new DOMMatrix(transform).m42;
  });
  await viewport.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, targetStart);
  await expect(viewport).not.toHaveJSProperty('scrollTop', 0);

  await viewport.hover();
  await page.mouse.wheel(0, -100);

  await expect
    .poll(() =>
      page.evaluate(() => window.__e2eCommands.filter((item) => item === 'paginate').length)
    )
    .toBe(1);
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

test('keeps a local echo and history anchor stable through confirmation', async ({ page }) => {
  await installRoomFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/home');
  await page.getByRole('link', { name: 'General' }).click();
  await expect(page.locator('.timeline-viewport.initial')).toHaveCount(0);

  const viewport = page.locator('.timeline-viewport .viewport');
  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect(page.locator('.jump-to-latest')).toBeVisible();
  const anchor = page.locator('.timeline-viewport .item').filter({ visible: true }).nth(2);
  const anchorId = await anchor.getAttribute('data-item-id');
  if (!anchorId) throw new Error('missing local echo anchor');
  const before = await anchor.boundingBox();
  if (!before) throw new Error('missing local echo anchor bounds');
  const subscription = await page.evaluate(() => window.__e2eTimelineSubscriptions[0]);
  const localEcho = {
    ...timelineItem('local-echo', 'Local echo'),
    event_id: null,
    transaction_id: 'txn-local-echo',
    send_state: { status: 'sending' as const },
  };

  await page.evaluate(
    ({ subscription, localEcho }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'push_back', value: localEcho }],
      });
    },
    { subscription, localEcho }
  );
  const echo = page.locator('[data-item-id="local-echo"]');
  await expect(echo).toHaveCount(1);
  await echo.evaluate((element) => {
    element.setAttribute('data-confirmation-marker', 'stable');
  });

  await page.evaluate(
    ({ subscription, remoteEcho }) => {
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'set', index: 20, value: remoteEcho }],
      });
    },
    {
      subscription,
      remoteEcho: {
        ...localEcho,
        event_id: '$local-echo:example.test',
        transaction_id: null,
        send_state: null,
      },
    }
  );

  await expect(echo).toHaveAttribute('data-confirmation-marker', 'stable');
  await expect
    .poll(async () => (await page.locator(`[data-item-id="${anchorId}"]`).boundingBox())?.y)
    .toBeCloseTo(before.y, 0);
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
