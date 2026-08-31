import { expect, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

const ROOM_ID = '!room:example.test';
const LATEST = 'General message 19';
const WRAPPED = `Receipted ${'and wrapped '.repeat(12)}`;

interface RowBox {
  badge: { top: number; bottom: number; left: number; right: number; height: number } | null;
  body: { bottom: number; right: number };
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
    expect(receipted.body.right).toBeLessThanOrEqual(badge.left);
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
        read_by: ['@bob:example.test', '@carol:example.test'],
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
  expect(receipted.body.right).toBeLessThanOrEqual(badge.left);

  if (plain.time && receipted.time) {
    expect(Math.abs(receipted.time.right - plain.time.right)).toBeLessThanOrEqual(1);
  }

  expect(badge.top).toBeLessThan(receipted.body.bottom);
  expect(Math.abs(badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
  expect(receipted.content.bottom - receipted.body.bottom).toBeLessThanOrEqual(2);

  const trigger = timeline.container.locator('[data-item-id="receipted"] .read-receipt-stack');
  const target = await trigger.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const after = getComputedStyle(element, '::after');
    return box.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom);
  });
  expect(target).toBeGreaterThanOrEqual(28);

  await trigger.click();
  await expect(page.getByRole('heading', { name: 'Read receipts' })).toBeVisible();
});
