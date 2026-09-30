import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

const eventId = (event: string) => `$general-${event}:example.test`;
const notifiedBy = (id: string) =>
  `/to/${encodeURIComponent('!room:example.test')}?notified=${encodeURIComponent(id)}`;
const notified = (event: string) => notifiedBy(eventId(event));

for (const height of [420, 900]) {
  test(`the reveal from a notification allows forward scrolling (height ${height})`, async ({
    page,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('forward_history');
    await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height });
    await page.goto(
      `/to/${encodeURIComponent('!room:example.test')}/${encodeURIComponent(eventId('4'))}`
    );
    await timeline.expectRevealed();
    await expect(timeline.message('General message 4')).toBeInViewport();
    await expect(timeline.message('General message 19')).toBeAttached();
    expect(await core.paginateCount()).toBeGreaterThanOrEqual(4);
    expect(await core.paginateCount()).toBeLessThan(16);
    await expect(timeline.message('General message 4')).toBeInViewport();
    await expect(timeline.itemById('filtered-forward')).toHaveCount(0);
    await expect
      .poll(
        async () => {
          await timeline.scrollToBottomAndNotify();
          return timeline.message('General message 79').isVisible();
        },
        { intervals: [250], timeout: 15_000 }
      )
      .toBe(true);
    await timeline.scrollToBottomAndNotify();
    await expect(timeline.message('General message 79')).toBeInViewport();
    expect(await core.paginateCount()).toBe(16);
  });
}

test('a notification opens the room live on its event', async ({
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto(notified('15'));
  await timeline.expectRevealed({ timeout: 15_000 });

  await expect(page.locator('.message.highlighted')).toContainText('General message 15');
  await expect(timeline.message('General message 15')).toBeInViewport();
  await expect(timeline.message('General message 5')).not.toBeInViewport();
  expect(new URL(page.url()).search).toBe('');

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    { op: 'push_back' as const, value: timelineItem('arrived', 'Arrived after the tap') },
  ]);
  await expect(timeline.itemById('arrived')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('event')).toBeNull();

  await page.reload();
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  await expect(page.locator('.message.highlighted')).toHaveCount(0);
});

test('a notification whose event is not loaded opens at the first unread', async ({
  page,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('unread');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto(notified('missing'));
  await timeline.expectRevealed({ timeout: 15_000 });

  await expect(timeline.message('General message 5')).toBeInViewport();
  await expect(page.locator('.message.highlighted')).toHaveCount(0);
});

test('a notification for an edit lands on the message it edited', async ({
  page,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('unread');
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto(notifiedBy('$edit:example.test'));
  await timeline.expectRevealed({ timeout: 15_000 });

  await expect(page.locator('.message.highlighted')).toContainText('General message 8');
  await expect(timeline.message('General message 8')).toBeInViewport();
});

test('a notification tapped while its room is open moves to the event', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect(timeline.message('General message 19')).toBeInViewport();

  await page.evaluate((event) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sable:open-room', roomId: '!room:example.test', eventId: event },
      })
    );
  }, eventId('3'));

  await expect(timeline.message('General message 3')).toBeInViewport();
  await expect(page.locator('.message.highlighted')).toContainText('General message 3');
  expect(new URL(page.url()).search).toBe('');
});
