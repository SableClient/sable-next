// Real stack. Anything needing a scripted transport belongs in
// timeline-anchoring.spec.ts or timeline-transport.spec.ts.

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { TIMELINE_MESSAGE_COUNT, TIMELINE_ROOM_NAME } from './fixtures/continuwuity';

test.use({ storageState: SIGNED_OUT });

const LATEST = `Timeline message ${String(TIMELINE_MESSAGE_COUNT - 1)}`;

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 420 });
});

test('shows the authenticated app shell on desktop', async ({ page, app, signIn }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn();

  await expect(app.primaryNavigation).toBeVisible();
  await expect(app.homeLink()).toHaveAttribute('aria-current', 'page');
  await expect(app.quickTools).toBeVisible();

  const scrollbars = await page.evaluate(() => {
    const roomNavigation = document.querySelector('.room-nav-content');
    return {
      gutter: getComputedStyle(document.documentElement).scrollbarGutter,
      roomNavigation: roomNavigation ? getComputedStyle(roomNavigation).scrollbarWidth : null,
    };
  });
  expect(scrollbars.gutter).toBe('auto');
  expect(scrollbars.roomNavigation).toBe('thin');
});

test('shows the authenticated app shell on mobile', async ({ page, app, signIn }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn();

  await expect(app.primaryNavigation).toBeVisible();
  await expect(app.homeLink()).toHaveAttribute('aria-current', 'page');
  await expect(app.mobileQuickTools).toBeVisible();
});

test('persists the keyboard-adjusted room navigation width', async ({ page, app, signIn }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn();

  await expect(app.resizeRooms).toHaveAttribute('aria-valuenow', '224');
  await app.resizeRooms.press('ArrowRight');
  await expect(app.resizeRooms).toHaveAttribute('aria-valuenow', '304');

  await page.reload();

  await expect(app.resizeRooms).toHaveAttribute('aria-valuenow', '304');
});

test('opens a desktop room from the list at latest', async ({ app, timeline, signIn }) => {
  await signIn();
  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
  await app.openRoomFromList(TIMELINE_ROOM_NAME);

  await timeline.expectAtLatest(LATEST);
});

test('opens a mobile room from the list at latest', async ({ page, app, timeline, signIn }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await signIn();
  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
  await app.openRoomFromList(TIMELINE_ROOM_NAME);

  await timeline.expectAtLatest(LATEST);
});

test('opens a direct desktop room route at latest', async ({
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);

  await timeline.expectAtLatest(LATEST);
  await expect(timeline.skeleton).toHaveCount(0);
});

test('opens a mobile room route without showing the room list first', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);

  await expect(app.roomHeading(TIMELINE_ROOM_NAME)).toBeVisible();
  await expect(app.mobileQuickTools).not.toBeInViewport();
  await timeline.expectAtLatest(LATEST);
});

test('keeps mobile bottom navigation with the room list panel', async ({ page, app, signIn }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn();
  await expect(app.mobileQuickTools).toBeInViewport();

  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
  await app.openRoomFromList(TIMELINE_ROOM_NAME);

  await expect(app.roomHeading(TIMELINE_ROOM_NAME)).toBeVisible();
  await expect(app.backToRooms).toBeVisible();
  await expect(page.locator('.mobile-quick-tools')).toHaveCount(0);

  await app.backToRooms.click();

  await expect(app.mobileQuickTools).toBeInViewport();
});

test('back closes the mobile room list before leaving a room', async ({
  page,
  app,
  homeserver,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);

  const drawerToggle = page.getByRole('button', { name: 'Show room list' });
  await drawerToggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Show conversation' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  await page.goBack();
  await expect(app.roomHeading(TIMELINE_ROOM_NAME)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show room list' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
});

test('reopens a room after returning to the mobile room list', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);
  await expect(app.roomHeading(TIMELINE_ROOM_NAME)).toBeVisible();

  await app.backToRooms.click();
  await app.openRoomFromList(TIMELINE_ROOM_NAME);

  await expect(app.roomHeading(TIMELINE_ROOM_NAME)).toBeVisible();
  await expect(app.backToRooms).toBeVisible();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
});

test('keeps the latest message visible when the mobile viewport resizes', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);
  await timeline.expectAtLatest(LATEST);

  await page.setViewportSize({ width: 390, height: 420 });
  await timeline.expectAtLatest(LATEST);

  await page.setViewportSize({ width: 390, height: 700 });
  await timeline.expectAtLatest(LATEST);
});

test('keeps the latest message visible when the composer grows', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);
  await timeline.expectAtLatest(LATEST);

  await app.composer.fill(
    Array.from({ length: 6 }, (_, index) => `Line ${String(index + 1)}`).join('\n')
  );

  await timeline.expectAtLatest(LATEST);
});

// A resize raises no scroll event, so nothing but the observer re-pins it.
test('keeps the latest message visible when the composer grows under a held pointer', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);
  await timeline.expectAtLatest(LATEST);

  await timeline.viewport.dispatchEvent('pointerdown');
  await app.composer.fill(
    Array.from({ length: 6 }, (_, index) => `Line ${String(index + 1)}`).join('\n')
  );

  await timeline.expectAtLatest(LATEST);
});

test('stays at latest when a measured timeline item grows', async ({
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);
  await timeline.expectAtLatest(LATEST);

  await timeline.items.last().evaluate((item) => {
    item.style.paddingBottom = '147px';
  });

  await timeline.expectAtLatest(LATEST);
});

test('preserves the visible history position when the mobile viewport resizes', async ({
  page,
  app,
  timeline,
  homeserver,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await signIn();
  await app.openRoom(homeserver.timelineRoomId);
  await timeline.expectAtLatest(LATEST);

  // History streams in after the first paint, so there is nothing to scroll
  // until the timeline overflows.
  await expect.poll(() => timeline.scrollableHeight(), { timeout: 15_000 }).toBeGreaterThan(300);
  await expect
    .poll(async () => {
      await timeline.wheelUp(300);
      return timeline.distanceFromBottom();
    })
    .toBeGreaterThan(80);
  const anchor = await timeline.fullyVisibleAnchor();

  await page.setViewportSize({ width: 390, height: 320 });

  // Real messages wrap to variable heights; re-measurement settles within a
  // couple of pixels.
  await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
});

test('opens a focused permalink at its target', async ({ app, timeline, homeserver, signIn }) => {
  await signIn();
  await app.openPermalink(homeserver.timelineRoomId, homeserver.timelineEventIds[10]);

  await expect(timeline.message('Timeline message 10')).toBeInViewport();
});

test('a matrix.to link redirects into the room it names', async ({
  app,
  timeline,
  homeserver,
  signIn,
  page,
}) => {
  const eventId = homeserver.timelineEventIds[10];
  await signIn();
  await app.openMatrixToLink(homeserver.timelineRoomId, eventId);

  await expect(page).toHaveURL(
    `/rooms/${encodeURIComponent(homeserver.timelineRoomId)}?event=${encodeURIComponent(eventId)}`
  );
  await expect(timeline.message('Timeline message 10')).toBeInViewport();
});
