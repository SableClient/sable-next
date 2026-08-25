// Exactly one subscribe and no stray pagination. The command log that proves it
// only exists on the double, and the rendered output looks identical either way.

import { expect, test } from './fixtures/test';

test('subscribes once when opening a room on mobile', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 390, height: 420 });
  await app.openHome();
  await app.openRoomFromList('General');

  await expect(app.roomHeading('General')).toBeVisible();
  await expect.poll(() => core.timelineCommands()).toEqual(['subscribe_timeline']);
});

test('subscribes once and loads initial room history', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openHome();
  await app.openRoomFromList('General');

  await expect(page.getByText('Welcome to General')).toBeVisible();
  // The snapshot does not fill a window this tall, so the opening fill pads it
  // out. This double reports the timeline start on its second page.
  await expect.poll(() => core.paginateCount()).toBe(2);
  expect(await core.subscribeCount()).toBe(1);

  // The prefetch fires on a settle, so a passing poll above proves nothing yet.
  await page.waitForTimeout(75);
  expect(await core.paginateCount()).toBe(2);
  expect(await core.subscribeCount()).toBe(1);
});

test('does not resubscribe the timeline after a room refresh', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');
  await expect(page.getByText('Welcome to General')).toBeVisible();

  await page.reload();

  await expect(page.getByText('Welcome to General')).toBeVisible();
  await timeline.expectAtLatest('General message 19');
  await expect.poll(() => core.timelineCommands()).toEqual(['subscribe_timeline']);
});

test('keeps the active timeline while crossing the layout breakpoint', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openHome();
  await app.openRoomFromList('General');
  await expect(page.getByText('Welcome to General')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });

  await expect.poll(() => core.subscribeCount()).toBe(1);
});

test('prefetches history within the oldest timeline items', async ({
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

  await timeline.scrollToAndNotify(await timeline.offsetOfIndex(8));
  await expect(timeline.viewport).not.toHaveJSProperty('scrollTop', 0);

  await timeline.wheelUp(100);

  await expect.poll(() => core.paginateCount()).toBe(1);
});

test('anchors each history page requested by separate upward gestures', async ({
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

  const first = timeline.items.first();
  const [firstId, firstIndexValue] = await Promise.all([
    first.getAttribute('data-item-id'),
    first.getAttribute('data-index'),
  ]);
  if (!firstId || firstIndexValue === null) throw new Error('missing first timeline item');
  const firstIndex = Number(firstIndexValue);
  if (!Number.isInteger(firstIndex)) throw new Error('invalid first timeline item index');

  await timeline.scrollTo(0);
  await timeline.wheelUp(200);

  await expect.poll(() => core.paginateCount()).toBe(1);
  await expect
    .poll(() => timeline.itemById(firstId).getAttribute('data-index'))
    .toBe(String(firstIndex + 1));
  // A second page must need a second gesture, so idling cannot produce one.
  await page.waitForTimeout(300);
  expect(await core.paginateCount()).toBe(1);
  await expect(timeline.viewport).not.toHaveJSProperty('scrollTop', 0);

  await page.waitForTimeout(150);
  await timeline.scrollTo(0);
  const beforeSecondPage = await timeline.itemById(firstId).boundingBox();
  if (!beforeSecondPage) throw new Error('missing second-page anchor bounds');
  await timeline.wheelUp(200);

  await expect.poll(() => core.paginateCount()).toBe(2);
  await expect
    .poll(() => timeline.itemById(firstId).getAttribute('data-index'))
    .toBe(String(firstIndex + 2));
  await expect
    .poll(async () => (await timeline.itemById(firstId).boundingBox())?.y)
    .toBeCloseTo(beforeSecondPage.y, 0);
});
