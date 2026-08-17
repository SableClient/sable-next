// Asserts the same messages stay on screen, not that scrollTop is unchanged: a
// virtualised list renumbers rows constantly, and the text is what a reader sees.

import { expect, test } from './fixtures/test';
import { historyItems, timelineImage, timelineItem } from './fixtures/timeline-items';

test('an edit above the viewport does not move the reader', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openHome();
  await app.openRoomFromList('General');
  await expect(timeline.initial).toHaveCount(0);
  await expect.poll(() => core.subscribeCount()).toBe(1);

  // Away from the end, so this is the anchor's job, not follow-to-bottom.
  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();

  const subscription = await core.subscription();
  const before = await timeline.visibleRange();

  await core.emitTimelineDiff(subscription, [
    {
      op: 'set',
      index: 1,
      value: {
        ...timelineItem('general-1', `Edited ${'and rewrapped '.repeat(12)}`),
        event_id: '$general-1:example.test',
      },
    },
  ]);

  await expect.poll(() => timeline.visibleRange()).toEqual(before);
});

test('a deletion above the viewport does not move the reader', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openHome();
  await app.openRoomFromList('General');
  await expect(timeline.initial).toHaveCount(0);
  await expect.poll(() => core.subscribeCount()).toBe(1);

  // Away from the end, so this is the anchor's job, not follow-to-bottom.
  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();

  const subscription = await core.subscription();
  const before = await timeline.visibleRange();

  // Content shrinking is the harsher direction: the rows below move up.
  await core.emitTimelineDiff(subscription, [{ op: 'remove', index: 1 }]);

  await expect.poll(() => timeline.visibleRange()).toEqual(before);
});

test('history inserted above the viewport does not move the reader', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openHome();
  await app.openRoomFromList('General');
  await expect(timeline.initial).toHaveCount(0);
  await expect.poll(() => core.subscribeCount()).toBe(1);

  // Away from the end, so this is the anchor's job, not follow-to-bottom.
  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();

  const subscription = await core.subscription();
  const before = await timeline.visibleRange();

  await core.emitTimelineDiff(
    subscription,
    historyItems({
      idPrefix: 'earlier',
      label: 'Earlier',
      count: 3,
      timestampBase: 1_699_990_000_000,
    }).map((value, index) => ({ op: 'insert' as const, index: index + 1, value }))
  );

  await expect.poll(() => timeline.visibleRange()).toEqual(before);
});

test('an image without dimensions takes the file shape without moving the reader', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openHome();
  await app.openRoomFromList('General');
  await expect(timeline.initial).toHaveCount(0);
  await expect.poll(() => core.subscribeCount()).toBe(1);

  const subscription = await core.subscription();
  const anchor = await timeline.fullyVisibleAnchor();

  // No dimensions on the event, so the box comes from the 1000x400 file.
  await core.emitTimelineDiff(subscription, [
    {
      op: 'insert',
      index: 1,
      value: {
        ...timelineImage('sizeless'),
        content: {
          ...timelineImage('sizeless').content,
          source: JSON.stringify({ Plain: 'mxc://example.test/wide-image' }),
          width: null,
          height: null,
        },
      },
    },
  ]);

  await expect(timeline.image).toBeVisible();
  await expect(timeline.image.locator('img')).toHaveCount(0);
  await expect(timeline.image.locator('img')).toBeVisible();
  const loaded = await timeline.image.boundingBox();
  if (!loaded) throw new Error('missing loaded image box');

  expect(loaded.width / loaded.height).toBeCloseTo(1000 / 400, 1);
  await timeline.expectAnchorHeld(anchor);
});
