import { expect, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

const ROOM_ID = '!room:example.test';
const LATEST = 'General message 19';
const WRAPPED = `Receipted ${'and wrapped '.repeat(12)}`;

interface RowBox {
  badge: { top: number; bottom: number; left: number; right: number; height: number } | null;
  body: { bottom: number; right: number };
  lastLine: { right: number };
  time: { right: number } | null;
  content: { right: number; bottom: number };
}

async function measure(page: import('@playwright/test').Page, itemId: string): Promise<RowBox> {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-item-id="${id}"]`);
    if (!row) throw new Error(`no rendered row for ${id}`);
    const content = row.querySelector('.message-content');
    const body = row.querySelector('.formatted-body');
    const badge = row.querySelector('.read-receipt-stack');
    const time = row.querySelector('header time');
    if (!content || !body) throw new Error(`row ${id} has no content box`);
    const box = (element: Element) => element.getBoundingClientRect();
    return {
      badge: badge
        ? {
            top: box(badge).top,
            bottom: box(badge).bottom,
            left: box(badge).left,
            right: box(badge).right,
            height: box(badge).height,
          }
        : null,
      body: { bottom: box(body).bottom, right: box(body).right },
      lastLine: { right: [...body.getClientRects()].at(-1)?.right ?? box(body).right },
      time: time ? { right: box(time).right } : null,
      content: { right: box(content).right, bottom: box(content).bottom },
    };
  }, itemId);
}

async function openReceiptedRoom(
  page: import('@playwright/test').Page,
  app: { openRoom: (roomId: string) => Promise<void> },
  timeline: {
    expectAtLatest: (body: string) => Promise<void>;
    container: import('@playwright/test').Locator;
  },
  core: {
    subscription: (index?: number) => Promise<number>;
    emitTimelineDiff: (subscription: number, diffs: Record<string, unknown>[]) => Promise<void>;
  }
): Promise<void> {
  await page.setViewportSize({ width: 390, height: 780 });
  await app.openRoom(ROOM_ID);
  await timeline.expectAtLatest(LATEST);

  const subscription = await core.subscription(0);
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...timelineItem('receipted', WRAPPED),
        sender: '@bob:example.test',
        sender_name: 'Bob',
        read_by: ['@bob:example.test', '@carol:example.test'],
      },
    },
  ]);

  await expect(timeline.container.locator('[data-item-id="receipted"]')).toBeVisible();
  await expect.poll(async () => (await measure(page, 'receipted')).badge !== null).toBe(true);
}

for (const layout of ['bubble', 'compact'] as const) {
  test(`the ${layout} layout keeps the badge beside the last line`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await page.addInitScript((value) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ layout: value }));
    }, layout);
    await openReceiptedRoom(page, app, timeline, core);

    const receipted = await measure(page, 'receipted');
    const badge = receipted.badge;
    if (!badge) throw new Error('no badge');

    expect(Math.abs(badge.right - receipted.content.right)).toBeLessThanOrEqual(1);
    expect(receipted.lastLine.right).toBeLessThanOrEqual(badge.left);
    expect(Math.abs(badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
    expect(receipted.content.bottom - receipted.body.bottom).toBeLessThanOrEqual(2);
  });
}

test('a receipt badge sits beside the last line and leaves the timestamp on the right', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 390, height: 780 });
  await app.openRoom(ROOM_ID);
  await timeline.expectAtLatest(LATEST);

  const plain = await measure(page, 'general-19');
  expect(plain.badge).toBeNull();

  const subscription = await core.subscription(0);
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...timelineItem('receipted', WRAPPED),
        sender: '@bob:example.test',
        sender_name: 'Bob',
        read_by: [
          '@bob:example.test',
          '@carol:example.test',
          '@dave:example.test',
          '@erin:example.test',
        ],
      },
    },
  ]);

  await expect(timeline.container.locator('[data-item-id="receipted"]')).toBeVisible();
  await expect.poll(async () => (await measure(page, 'receipted')).badge !== null).toBe(true);

  const receipted = await measure(page, 'receipted');
  const badge = receipted.badge;
  if (!badge) throw new Error('no badge');

  expect(badge.height).toBeGreaterThan(0);
  expect(Math.abs(badge.right - receipted.content.right)).toBeLessThanOrEqual(1);
  expect(receipted.lastLine.right).toBeLessThanOrEqual(badge.left);

  if (plain.time && receipted.time) {
    expect(Math.abs(receipted.time.right - plain.time.right)).toBeLessThanOrEqual(1);
  }

  expect(badge.top).toBeLessThan(receipted.body.bottom);
  expect(Math.abs(badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
  expect(receipted.content.bottom - receipted.body.bottom).toBeLessThanOrEqual(2);

  const profileFaces = timeline.container.locator(
    '[data-item-id="receipted"] .read-receipt-stack .face'
  );
  await expect(profileFaces).toHaveCount(3);
  const faceSizes = await profileFaces.evaluateAll((elements) =>
    elements.map((element) => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    })
  );
  expect(faceSizes.every(({ width, height }) => width >= 24 && height >= 24)).toBe(true);

  const overflow = timeline.container.locator(
    '[data-item-id="receipted"] .read-receipt-stack .overflow'
  );
  const target = await overflow.evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  });
  expect(target.width).toBeGreaterThanOrEqual(24);
  expect(target.height).toBeGreaterThanOrEqual(24);

  await overflow.click();
  await expect(page.getByRole('heading', { name: 'Read receipts' })).toBeVisible();
});

test('an emote-only message keeps the badge on its bottom edge', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 390, height: 780 });
  await app.openRoom(ROOM_ID);
  await timeline.expectAtLatest(LATEST);

  const base = timelineItem('receipted', ':party:');
  const subscription = await core.subscription(0);
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...base,
        content: {
          ...base.content,
          html: '<img src="mxc://example.test/emote" alt=":party:" title=":party:" />',
        },
        sender: '@bob:example.test',
        sender_name: 'Bob',
        read_by: ['@bob:example.test', '@carol:example.test'],
      },
    },
  ]);

  await expect(timeline.container.locator('[data-item-id="receipted"]')).toBeVisible();
  await expect.poll(async () => (await measure(page, 'receipted')).badge !== null).toBe(true);

  const receipted = await measure(page, 'receipted');
  const badge = receipted.badge;
  if (!badge) throw new Error('no badge');

  expect(Math.abs(badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
  expect(badge.height).toBeLessThanOrEqual(30);
});

test('a short receipted bubble keeps its text on one line', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ layout: 'bubble' }));
  });
  await page.setViewportSize({ width: 390, height: 780 });
  await app.openRoom(ROOM_ID);
  await timeline.expectAtLatest(LATEST);

  const subscription = await core.subscription(0);
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...timelineItem('receipted', 'miam miam'),
        sender: '@bob:example.test',
        sender_name: 'Bob',
        read_by: ['@bob:example.test', '@carol:example.test'],
      },
    },
    {
      op: 'push_back',
      value: {
        ...timelineItem('own-receipted', 'miam miam'),
        is_own: true,
        read_by: ['@bob:example.test', '@carol:example.test'],
      },
    },
  ]);

  for (const id of ['receipted', 'own-receipted']) {
    await expect(timeline.container.locator(`[data-item-id="${id}"]`)).toBeVisible();
    await expect.poll(async () => (await measure(page, id)).badge !== null).toBe(true);

    const lines = await page.evaluate((itemId) => {
      const body = document.querySelector(`[data-item-id="${itemId}"] .formatted-body`);
      if (!body) return null;
      const range = document.createRange();
      range.selectNodeContents(body);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    }, id);
    const receipted = await measure(page, id);
    const badge = receipted.badge;
    if (!badge) throw new Error('no badge');

    expect(lines).toBe(1);
    expect(receipted.lastLine.right).toBeLessThanOrEqual(badge.left);
  }
});

test('a short receipted notice keeps its text on one line', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ layout: 'bubble' }));
  });
  await page.setViewportSize({ width: 390, height: 780 });
  await app.openRoom(ROOM_ID);
  await timeline.expectAtLatest(LATEST);

  const base = timelineItem('receipted-notice', 'miam miam');
  const subscription = await core.subscription(0);
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...base,
        content: { ...base.content, html: '<p>miam miam</p>', notice: true },
        sender: '@bob:example.test',
        sender_name: 'Bob',
        read_by: ['@bob:example.test', '@carol:example.test'],
      },
    },
  ]);

  await expect(timeline.container.locator('[data-item-id="receipted-notice"]')).toBeVisible();
  await expect
    .poll(async () => (await measure(page, 'receipted-notice')).badge !== null)
    .toBe(true);

  const lines = await page.evaluate(() => {
    const body = document.querySelector('[data-item-id="receipted-notice"] .formatted-body');
    if (!body) return null;
    const range = document.createRange();
    range.selectNodeContents(body);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  const receipted = await measure(page, 'receipted-notice');
  const badge = receipted.badge;
  if (!badge) throw new Error('no badge');

  expect(lines).toBe(1);
  expect(Math.abs(badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
  expect(receipted.content.bottom - receipted.body.bottom).toBeLessThanOrEqual(2);
});
