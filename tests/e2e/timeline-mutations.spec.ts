// Asserts the same messages stay on screen, not that scrollTop is unchanged: a
// virtualised list renumbers rows constantly, and the text is what a reader sees.

import { expect, test } from './fixtures/test';
import { solidPng } from './fixtures/png';

test.beforeEach(async ({ page, timeline }) => {
  test.setTimeout(120_000);
  await timeline.trackRebuilds();
  await page.setViewportSize({ width: 1280, height: 420 });
});

test.fixme('an edit above the viewport does not move the reader', async ({
  app,
  timeline,
  admin,
  deepRoom,
}) => {
  await app.openRoom(deepRoom.roomId);
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);

  // Away from the end, so this is the anchor's job, not follow-to-bottom.
  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();

  const before = await timeline.visibleRange();
  const above = await timeline.items.first().getAttribute('data-event-id');
  if (!above) throw new Error('no rendered row above the reader');

  await admin.editMessage(deepRoom.roomId, above, `Edited ${'and rewrapped '.repeat(12)}`);

  await expect(timeline.container.getByText(/and rewrapped/).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => timeline.visibleRange()).toEqual(before);
});

test.fixme('a deletion above the viewport does not move the reader', async ({
  app,
  timeline,
  admin,
  deepRoom,
}) => {
  await app.openRoom(deepRoom.roomId);
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);

  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();

  const before = await timeline.visibleRange();
  const doomed = await timeline.items.first().getAttribute('data-event-id');
  if (!doomed) throw new Error('no rendered row above the reader');

  await admin.redact(deepRoom.roomId, doomed);

  await expect.poll(() => timeline.itemByEventId(doomed).count(), { timeout: 20_000 }).toBe(0);
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

test('an edited message keeps its marker on the body line', async ({
  page,
  app,
  timeline,
  admin,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const roomId = await admin.createRoom({ name: `Edit marker ${String(Date.now())}` });
  await admin.sendMessage(roomId, 'Marker header owner');
  await admin.sendMessage(roomId, 'Marker plain');
  const editable = await admin.sendMessage(roomId, 'Marker before edit');

  await app.openRoom(roomId);
  await timeline.expectRevealed();
  await expect(timeline.message('Marker plain')).toBeVisible({ timeout: 20_000 });

  await admin.editMessage(roomId, editable, 'Marker edited');
  await expect(timeline.container.getByText('Marker edited')).toBeVisible({ timeout: 20_000 });

  const plainRow = timeline.container.locator('.item').filter({ hasText: 'Marker plain' });
  const editedRow = timeline.container.locator('.item').filter({ hasText: 'Marker edited' });
  const [plainBox, editedBox] = await Promise.all([
    plainRow.boundingBox(),
    editedRow.boundingBox(),
  ]);
  if (!plainBox || !editedBox) throw new Error('missing marker row bounds');

  expect(editedBox.height).toBeCloseTo(plainBox.height, 0);
});
