import { expect, test, SIGNED_OUT } from './fixtures/test';
import {
  TIMELINE_MESSAGE_COUNT,
  TIMELINE_ROOM_NAME,
  sendTimelineMessage,
} from './fixtures/continuwuity';

test.use({ storageState: SIGNED_OUT });

test('loads a real room at latest and preserves the viewport while paginating', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 420 });
  await signIn();
  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
  await app.openRoomFromList(TIMELINE_ROOM_NAME);
  await expect(page).toHaveURL(`/rooms/${encodeURIComponent(homeserver.timelineRoomId)}`);

  const latest = timeline.message(`Timeline message ${String(TIMELINE_MESSAGE_COUNT - 1)}`);
  await expect(latest).toBeInViewport({ timeout: 15_000 });
  await expect
    .poll(() =>
      timeline.viewport.evaluate((element) => ({
        distance: element.scrollHeight - element.scrollTop - element.clientHeight,
        overflow: element.scrollHeight > element.clientHeight,
      }))
    )
    .toEqual({ distance: 0, overflow: true });
  await expect(timeline.loading).toHaveCount(0);

  await expect.poll(() => timeline.scrollableHeight(), { timeout: 15_000 }).toBeGreaterThan(300);
  const oldestRenderedMessage = async (): Promise<number> =>
    timeline.items.evaluateAll((items) => {
      const indexes = items.flatMap((item) => {
        const match = item.textContent.match(/Timeline message (\d+)/);
        return match ? [Number(match[1])] : [];
      });
      return Math.min(...indexes);
    });
  const initialOldestMessage = await oldestRenderedMessage();
  await timeline.wheelUp(200);
  await expect(timeline.jumpToLatest).toBeVisible();
  await timeline.dispatchWheel(1);
  await timeline.scrollToAndNotify(0);
  await expect.poll(oldestRenderedMessage, { timeout: 15_000 }).toBeLessThan(initialOldestMessage);

  const beforeOldestMessage = await oldestRenderedMessage();

  await timeline.dispatchWheel(-200);
  await timeline.scrollToAndNotify(0);
  await expect.poll(oldestRenderedMessage, { timeout: 15_000 }).toBeLessThan(beforeOldestMessage);

  await timeline.waitForScrollSettled();
  await expect.poll(() => timeline.visibleItems().count()).toBeGreaterThan(0);
  const anchor = await timeline.fullyVisibleAnchor({ skip: 1 });

  await timeline.dispatchWheel(-200);
  await timeline.notifyScroll();

  // Real messages wrap to variable heights; re-measurement settles within a
  // couple of pixels.
  await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
});

test('keeps the live subscription when another tab restores the shared session', async ({
  page,
  app,
  context,
  timeline,
  homeserver,
  signIn,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 420 });
  await signIn();
  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
  await app.openRoomFromList(TIMELINE_ROOM_NAME);
  await expect(timeline.loading).toHaveCount(0);

  const secondPage = await context.newPage();
  await secondPage.goto('/rooms');
  await expect(secondPage.getByRole('link', { name: TIMELINE_ROOM_NAME })).toBeVisible({
    timeout: 15_000,
  });

  const body = `Live after second restore ${String(Date.now())}`;
  await sendTimelineMessage(
    homeserver.baseUrl,
    homeserver.accessToken,
    homeserver.timelineRoomId,
    `live-${String(Date.now())}`,
    body
  );

  await page.bringToFront();

  await expect(timeline.message(body)).toBeInViewport({ timeout: 15_000 });
  await secondPage.close();
});
