import { expect, test, SIGNED_OUT } from './fixtures/test';
import {
  TIMELINE_MESSAGE_COUNT,
  TIMELINE_ROOM_NAME,
  sendTimelineMessage,
} from './fixtures/continuwuity';

test.use({ storageState: SIGNED_OUT });

test('mobile timeline truncates a long emote sender instead of scrolling sideways', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
  scratchRoom,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn();
  await app.openRoomFromList(scratchRoom.name);
  await expect(timeline.loading).toHaveCount(0);
  const body = `long emote sender ${String(Date.now())}`;

  const response = await fetch(
    `${homeserver.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(scratchRoom.roomId)}/send/m.room.message/long-emote-sender`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${homeserver.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ msgtype: 'm.emote', body }),
    }
  );
  if (!response.ok) throw new Error(`could not send emote: ${String(response.status)}`);

  const emote = page.locator('.emote').filter({ hasText: body });
  await expect(emote).toBeVisible();
  const sender = emote.locator('.sender');
  const sideways = await sender.evaluate((node) => {
    node.textContent = `* ${'a'.repeat(200)}`;
    const viewport = node.closest('.viewport');
    if (!viewport) throw new Error('timeline viewport not found');
    return viewport.scrollWidth - viewport.clientWidth;
  });

  expect(sideways).toBe(0);
});

test('loads a real room at latest and preserves the viewport while paginating', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
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
  await expect.poll(() => timeline.distanceFromBottom()).toBeGreaterThan(0);
  const wheelUpUntilOlder = async (than: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          await timeline.wheelUp(400);
          await timeline.waitForScrollSettled();
          return oldestRenderedMessage();
        },
        { timeout: 15_000 }
      )
      .toBeLessThan(than);
  };
  await wheelUpUntilOlder(initialOldestMessage);

  const beforeOldestMessage = await oldestRenderedMessage();
  await wheelUpUntilOlder(beforeOldestMessage);

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
  scratchRoom,
}) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await signIn();
  await expect(app.roomLink(scratchRoom.name)).toBeVisible({ timeout: 15_000 });
  await app.openRoomFromList(scratchRoom.name);
  await expect(timeline.loading).toHaveCount(0);

  const secondPage = await context.newPage();
  await secondPage.goto('/rooms');
  await expect(secondPage.getByRole('link', { name: scratchRoom.name })).toBeVisible({
    timeout: 15_000,
  });

  const body = `Live after second restore ${String(Date.now())}`;
  await sendTimelineMessage(
    homeserver.baseUrl,
    homeserver.accessToken,
    scratchRoom.roomId,
    `live-${String(Date.now())}`,
    body
  );

  await page.bringToFront();

  await expect(timeline.message(body)).toBeInViewport({ timeout: 15_000 });
  await secondPage.close();
});
