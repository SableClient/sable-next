// Scripted transport, because a real homeserver cannot emit a `reset`
// mid-scroll, delay a snapshot on cue, or confirm a local echo at a chosen
// moment.

import { expect, test, SIGNED_OUT } from './fixtures/test';
import {
  historyItems,
  timelineImage,
  timelineItem,
  timelineMessage,
} from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

const ROOM_ID = '!room:example.test';
const LATEST = 'General message 19';

test('keeps the latest message visible when the typing indicator appears', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRoom(ROOM_ID);
  await timeline.expectAtLatest(LATEST);

  await core.emitTyping(ROOM_ID, ['@alice:example.test']);

  await expect(page.getByText('Alice is typing...')).toBeVisible();
  await timeline.expectAtLatest(LATEST);
});

test('switches the active timeline to the selected room', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await expect(page.getByText('Welcome to General')).toBeVisible();
  await app.openRoomFromList('Random');

  await expect.poll(() => core.subscribeCount()).toBe(2);
  await expect(page.getByText('Welcome to Random')).toBeVisible();

  const staleSubscription = await core.subscription(0);
  await core.emitTimelineDiff(staleSubscription, [
    { op: 'push_back', value: timelineItem('stale', 'Stale General event') },
  ]);

  await expect(page.getByText('Stale General event')).not.toBeVisible();
});

test('keeps a visible event fixed while history prepends', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');

  await expect(timeline.container).not.toHaveClass(/initial/, { timeout: 20_000 });
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  await expect(timeline.loading).toHaveCount(0);

  const subscription = await core.subscription();
  const anchor = await timeline.anchorAt(2);
  const positions = await core.sampleAnchorWhile(
    anchor.itemId,
    subscription,
    [
      { op: 'insert', index: 1, value: timelineItem('prepended-1', 'Prepended history 1') },
      { op: 'insert', index: 2, value: timelineItem('prepended-2', 'Prepended history 2') },
      { op: 'set', index: 1, value: timelineItem('prepended-1', 'Prepended history 1') },
    ],
    500
  );

  expect(
    Math.max(...positions.map((position) => Math.abs(position - anchor.y)))
  ).toBeLessThanOrEqual(1);
  await timeline.expectAnchorHeld(anchor);
});

test('falls back to a surviving visible anchor when the first row is replaced', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();
  await timeline.dispatchWheel(1);
  await timeline.scrollToAndNotify(0);
  await page.waitForTimeout(200);

  const subscription = await core.subscription();
  const anchor = await timeline.anchorAt(1);

  await core.emitTimelineDiff(subscription, [
    { op: 'remove', index: 0 },
    { op: 'push_front', value: timelineItem('replacement-1', 'Replacement history 1') },
    { op: 'push_front', value: timelineItem('replacement-2', 'Replacement history 2') },
  ]);

  await timeline.expectAnchorHeld(anchor);
});

test('anchors a large reset by surviving event identity', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await expect(timeline.message(LATEST)).toBeVisible();
  await timeline.expectRevealed();

  const subscription = await core.subscription();
  const initialHistory = historyItems({
    idPrefix: 'initial-history',
    label: 'Initial history',
    count: 20,
    timestampBase: 1_699_998_000_000,
  });
  await core.emitTimelineDiff(
    subscription,
    initialHistory.map((value, index) => ({ op: 'insert', index, value }))
  );
  await expect.poll(() => timeline.scrollableHeight()).toBeGreaterThan(300);

  const anchor = timeline.itemByEventId('$general-0:example.test');
  await timeline.wheelUp(300);
  await expect(timeline.jumpToLatest).toBeVisible();
  await timeline.dispatchWheel(1);
  await timeline.scrollToMiddleAndNotify();
  await expect(anchor).toHaveCount(1);
  await expect.poll(() => timeline.distanceFromBottom()).toBeGreaterThan(80);
  await page.waitForTimeout(200);

  await expect(anchor).toBeInViewport();
  const before = await anchor.boundingBox();
  if (!before) throw new Error('missing anchor event');

  const items = [
    ...historyItems({
      idPrefix: 'history-reset',
      label: 'Reset history',
      count: 80,
      timestampBase: 1_699_999_000_000,
    }),
    ...Array.from({ length: 20 }, (_, index) => ({
      ...timelineItem(
        `replacement-${String(index)}`,
        index === 0 ? 'Welcome to General' : `General message ${String(index)}`
      ),
      event_id: `$general-${String(index)}:example.test`,
      timestamp: 1_700_000_000_000 + index,
    })),
  ];
  await core.emitTimelineDiff(subscription, [{ op: 'reset', values: items }]);

  await expect
    .poll(async () => (await anchor.boundingBox())?.y, { timeout: 5_000 })
    .toBeCloseTo(before.y, 0);
});

test('keeps a visible event fixed when a prepended image loads', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');

  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);

  const subscription = await core.subscription();
  const anchor = await timeline.anchorAt(3);

  await core.emitTimelineDiff(subscription, [
    { op: 'insert', index: 1, value: timelineImage('prepended-image') },
  ]);

  await expect(timeline.image).toBeVisible();
  await expect(timeline.image.locator('img')).toHaveCount(0);
  const placeholderBounds = await timeline.image.boundingBox();
  if (!placeholderBounds) throw new Error('missing image placeholder bounds');

  await expect(timeline.image.locator('img')).toBeVisible();
  const loadedBounds = await timeline.image.boundingBox();
  if (!loadedBounds) throw new Error('missing loaded image bounds');
  expect(placeholderBounds.width).toBeCloseTo(400, 0);
  expect(loadedBounds.width).toBeCloseTo(placeholderBounds.width, 0);
  expect(loadedBounds.height).toBeCloseTo(placeholderBounds.height, 0);
  await timeline.expectAnchorHeld(anchor);
});

test('keeps a visible event fixed while a prepend is measured during backward scroll', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');

  const subscription = await core.subscription();
  await timeline.scrollAboveBottomAndNotify(300);
  const anchor = await timeline.anchorAt(3, { visibleOnly: true });

  const history = historyItems({
    idPrefix: 'measured-history',
    label: 'Measured history',
    count: 20,
    timestampBase: 1_699_999_000_000,
    body: (index) =>
      index % 2 === 0
        ? `Measured history ${String(index)}\n${'long content '.repeat(30)}`
        : `Measured history ${String(index)}`,
  });
  const positions = await core.sampleAnchorWhile(
    anchor.itemId,
    subscription,
    history.map((value, index) => ({ op: 'insert', index, value })),
    500
  );

  await timeline.expectAnchorHeld(anchor);
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(2);
});

test('keeps the first loaded message fixed when it becomes a continuation', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');

  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  await expect(timeline.loading).toHaveCount(0);

  const subscription = await core.subscription();
  const anchor = await timeline.anchorAt(1);

  await core.emitTimelineDiff(subscription, [
    {
      op: 'insert',
      index: 1,
      value: timelineMessage(
        'predecessor',
        '@alice:example.test',
        1_700_000_000_000,
        'Earlier message'
      ),
    },
  ]);

  await expect.poll(() => timeline.itemById(anchor.itemId).boundingBox()).not.toBeNull();
  await timeline.expectAnchorHeld(anchor);
});

test('only follows appended events while pinned at latest', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');

  const subscription = await core.subscription();
  await timeline.scrollToAndNotify(200);
  const before = await timeline.scrollTop();

  await core.emitTimelineDiff(subscription, [
    { op: 'push_back', value: timelineItem('reader-append', 'Reader append') },
  ]);
  await expect
    .poll(() => timeline.viewport.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(0);
  expect(await timeline.scrollTop()).toBe(before);

  await timeline.scrollToBottomAndNotify();
  await core.emitTimelineDiff(subscription, [
    { op: 'push_back', value: timelineItem('pinned-append', 'Pinned append') },
  ]);

  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
});

test('keeps a local echo and the visible position stable through confirmation', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await expect(timeline.container).not.toHaveClass(/initial/, { timeout: 20_000 });

  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();

  const subscription = await core.subscription();
  const localEcho = {
    ...timelineItem('local-echo', 'Local echo'),
    event_id: null,
    transaction_id: 'txn-local-echo',
    send_state: { status: 'sending' as const },
  };

  await core.emitTimelineDiff(subscription, [{ op: 'push_back', value: localEcho }]);
  const echo = timeline.itemById('local-echo');
  await expect(echo).toHaveCount(1);
  await echo.evaluate((element) => {
    element.setAttribute('data-confirmation-marker', 'stable');
  });

  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  const anchor = await timeline.fullyVisibleAnchor();

  await core.setTimelineItemById(subscription, 'local-echo', {
    ...localEcho,
    event_id: '$local-echo:example.test',
    transaction_id: null,
    send_state: null,
  });

  await expect(echo).toHaveAttribute('data-confirmation-marker', 'stable');
  await timeline.expectAnchorHeld(anchor);
});

test('anchors after a delayed initial snapshot', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('delayed_snapshot');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRoom(ROOM_ID, { settled: false });

  await expect(timeline.skeleton).toBeVisible();
  await expect(timeline.initial).toBeHidden();
  await timeline.expectAtLatest(LATEST);
  await expect(timeline.skeleton).toHaveCount(0);
});

test('shows the empty state rather than message rows in a room with no history', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('empty_room');
  await page.setViewportSize({ width: 1280, height: 800 });
  await app.openRoom(ROOM_ID, { settled: false });

  await expect(timeline.empty).toHaveText(/No messages yet/);
  await expect(timeline.skeleton).toHaveCount(0);
});

test('stays at latest when a delayed diff changes an overflowing snapshot height', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('delayed_layout_diff');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRoom(ROOM_ID, { settled: false });

  await timeline.expectAtLatest(`Delayed layout event ${'wraps '.repeat(80)}`);
});

test('anchors at latest after delayed initial history arrives', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('delayed_history');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');
  // The short snapshot needs another history page. Do not reveal it at its
  // intermediate position before the landing can anchor the complete page.
  await expect(timeline.initial).toHaveCount(1);

  await expect(timeline.message('Delayed history 0')).toBeVisible({ timeout: 2_000 });
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  await timeline.expectRevealed();
});

test('anchors delayed history inserted after a stable date divider', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_pagination');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  const anchor = timeline.itemByEventId('$general-0:example.test');
  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();
  await timeline.dispatchWheel(1);
  await timeline.scrollTo(0);
  const before = await anchor.boundingBox();
  if (!before) throw new Error('missing history anchor');

  await timeline.wheelUp(100);
  await expect.poll(() => core.paginateCount()).toBe(1);
  await expect.poll(() => anchor.getAttribute('data-index'), { timeout: 3_000 }).toBe('21');
  await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(before.y, 0);
});

test('anchors delayed history from a nonzero oldest-threshold offset', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_pagination');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();
  await timeline.dispatchWheel(1);
  await timeline.scrollToAndNotify(await timeline.offsetOfIndex(8));

  const anchor = timeline.itemByEventId('$general-8:example.test');
  const beforePrepend = await anchor.boundingBox();
  if (!beforePrepend) throw new Error('missing nonzero history anchor');

  await timeline.dispatchWheel(-100);
  await expect.poll(() => core.paginateCount()).toBe(1);
  await expect.poll(() => anchor.getAttribute('data-index'), { timeout: 3_000 }).toBe('29');
  await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(beforePrepend.y, 0);
});

// A room whose content does not overflow cannot raise a scroll event, so the
// wheel's gesture flag stays set and the end-follow used to decline. Prepended
// history then pushed the newest message out of view for good.
test('stays at the newest message when history lands in a room that fits', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 1200 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect.poll(() => timeline.scrollableHeight()).toBe(0);

  await timeline.wheelUp(200);
  const subscription = await core.subscription();
  await core.emitTimelineDiff(
    subscription,
    Array.from({ length: 25 }, (_unused, index) => ({
      op: 'insert' as const,
      index,
      value: timelineItem(`older-${String(index)}`, `Older history ${String(index)}`),
    }))
  );

  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  await expect(timeline.jumpToLatest).toBeHidden();
});

// A context menu holds a press the viewport never sees released. A press is not
// a scroll, so it must not stop the newest event from being followed.
test('opens at the first unread message rather than the newest', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('unread');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  await expect(timeline.message('General message 5')).toBeVisible();
  await expect(timeline.jumpToLatest).toBeVisible();
  await expect.poll(() => timeline.distanceFromBottom()).toBeGreaterThan(0);
});

test('follows an appended event while a pointer rests on the timeline', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 500 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect.poll(() => timeline.scrollableHeight()).toBeGreaterThan(100);
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);

  await timeline.viewport.dispatchEvent('pointerdown');

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    { op: 'push_back' as const, value: timelineItem('appended-held', 'Appended while held') },
  ]);

  await expect(timeline.message('Appended while held')).toBeVisible();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
});

// A room opened on its first unread is anchored, not pinned, so the message just
// sent lands below the fold unless sending goes to the newest event.
test('follows a sent message from a room opened on its first unread', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect(timeline.jumpToLatest).toBeVisible();

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back' as const,
      value: {
        ...timelineItem('echo', 'A message I just sent'),
        event_id: null,
        transaction_id: 'txn-1',
        is_own: true,
      },
    },
  ]);

  // Promptly: following on the next frame is the point, not eventually.
  await expect.poll(() => timeline.distanceFromBottom(), { timeout: 1_000 }).toBe(0);
  await expect(timeline.itemById('echo')).toBeInViewport();
});

test('follows a sent message after a wheel that could not scroll', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);

  await timeline.wheelUp(-200);

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    { op: 'push_back' as const, value: timelineItem('sent', 'A message I just sent') },
  ]);

  await expect(timeline.itemById('sent')).toBeInViewport();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
});
