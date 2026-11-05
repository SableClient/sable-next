import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';
import type { RoomListSnapshot } from '../../src/lib/rooms/room-list-snapshot';

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

test('a notification whose event cannot be found opens at the first unread', async ({
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

test('the reveal from an OS notification recovers from an unavailable message', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('unread_context_error');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  const roomUrl = page.url();
  await page.goto(`${roomUrl}?event=${encodeURIComponent(eventId('missing'))}`);
  await expect(page.getByText('This message could not be loaded', { exact: true })).toBeVisible();

  await page.evaluate((event) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sable:open-room', roomId: '!room:example.test', eventId: event },
      })
    );
  }, eventId('missing'));

  await expect(page.getByText('This message could not be loaded', { exact: true })).toHaveCount(0);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 9999')).toBeInViewport();
  expect(new URL(page.url()).searchParams.has('event')).toBe(false);
  const lookups = await page.evaluate(
    (event) =>
      window.__e2eCalls.filter((call) => {
        const params = call.params as { focus?: { event_id?: string } };
        return call.method === 'timeline.subscribe' && params.focus?.event_id === event;
      }).length,
    eventId('missing')
  );
  expect(lookups).toBe(2);
});

test('a newer notification tap wins when an older room is listed late', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('sable.room-list.v2.e2e-account')))
    .not.toBeNull();
  const room = await page.evaluate(() => {
    const saved = localStorage.getItem('sable.room-list.v2.e2e-account');
    if (saved === null) throw new Error('Room list snapshot is missing');
    const snapshot = JSON.parse(saved) as RoomListSnapshot;
    return snapshot.rooms[0];
  });
  await page.evaluate(() => {
    window.__e2eEmitTimelineEvent({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'remove', index: 0 }],
      sections: null,
    });
  });
  await expect(app.roomLink('General')).toHaveCount(0);
  await page.evaluate(async () => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sable:open-room', roomId: '!room:example.test' },
      })
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          resolve();
        })
      )
    );
  });
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sable:open-room', roomId: '!second:example.test' },
      })
    );
  });
  await expect(page).toHaveURL(/\/rooms\/!second%3Aexample.test$/);
  await expect(page.getByRole('heading', { name: 'Random', exact: true })).toBeVisible();
  await page.evaluate(async (room) => {
    window.__e2eEmitTimelineEvent({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'push_front', value: room }],
      sections: null,
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          resolve();
        })
      )
    );
  }, room);
  await expect(app.roomLink('General')).toBeVisible();
  await expect(page).toHaveURL(/\/rooms\/!second%3Aexample.test$/);
  await expect(page.getByRole('heading', { name: 'Random', exact: true })).toBeVisible();
});
