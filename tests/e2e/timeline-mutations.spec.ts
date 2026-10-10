// Asserts the same messages stay on screen, not that scrollTop is unchanged: a
// virtualised list renumbers rows constantly, and the text is what a reader sees.

import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test } from './fixtures/test';
import { solidPng } from './fixtures/png';

test.beforeEach(async ({ page, timeline }) => {
  test.setTimeout(120_000);
  await timeline.trackRebuilds();
  await page.setViewportSize({ width: 1280, height: 420 });
});

test('an edit above the viewport does not move the reader', async ({
  app,
  timeline,
  admin,
  deepRoom,
}) => {
  await app.openRoom(deepRoom.roomId);
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);

  // Away from the end, so this is the anchor's job, not follow-to-bottom.
  await timeline.wheelUp(await timeline.viewport.evaluate((node) => node.clientHeight + 30));
  await expect(timeline.jumpToLatest).toBeVisible();
  await timeline.waitForScrollSettled();

  const before = await timeline.visibleRange();
  await expect.poll(() => timeline.eventIdAboveViewport()).not.toBeNull();
  const above = await timeline.eventIdAboveViewport();
  if (!above) throw new Error('no rendered row above the reader');

  await admin.editMessage(deepRoom.roomId, above, `Edited ${'and rewrapped '.repeat(12)}`);

  await expect(timeline.container.getByText(/and rewrapped/).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => timeline.visibleRange()).toEqual(before);
});

test('a deletion above the viewport does not move the reader', async ({
  app,
  timeline,
  admin,
  deepRoom,
}) => {
  await app.openRoom(deepRoom.roomId);
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);

  await timeline.wheelUp(await timeline.viewport.evaluate((node) => node.clientHeight + 30));
  await expect(timeline.jumpToLatest).toBeVisible();
  await timeline.waitForScrollSettled();

  const before = await timeline.visibleRange();
  await expect.poll(() => timeline.eventIdAboveViewport()).not.toBeNull();
  const doomed = await timeline.eventIdAboveViewport();
  if (!doomed) throw new Error('no rendered row above the reader');

  await admin.redact(deepRoom.roomId, doomed);

  await expect(timeline.itemByEventId(doomed)).toContainText(en.timeline.redacted, {
    timeout: 20_000,
  });
  await expect.poll(() => timeline.visibleRange()).toEqual(before);
});

test('an image without dimensions takes the file shape without losing the newest message', async ({
  page,
  app,
  timeline,
  admin,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const roomId = await admin.createRoom({ name: `Sizeless image ${String(Date.now())}` });
  const last = `Newest after the image ${String(Date.now())}`;
  const url = await admin.uploadMedia(solidPng(1000, 400), 'image/png', 'wide.png');

  await app.openRoom(roomId);
  await timeline.expectRevealed();

  await admin.sendImage(roomId, url, { body: 'wide.png' });
  await admin.sendMessage(roomId, last);

  await expect(timeline.image).toBeVisible({ timeout: 20_000 });
  await expect(timeline.image.locator('img')).toBeVisible({ timeout: 20_000 });
  const loaded = await timeline.image.boundingBox();
  if (!loaded) throw new Error('missing loaded image box');

  expect(loaded.width / loaded.height).toBeCloseTo(1000 / 400, 1);
  await timeline.expectAtLatest(last);
});
