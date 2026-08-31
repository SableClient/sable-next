import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { HomeserverProxy } from './fixtures/proxy';

const MESSAGES = /GET \/_matrix\/client\/v[13]\/rooms\/[^ ]*\/messages/;

test.use({ storageState: SIGNED_OUT });

function pages(proxy: HomeserverProxy): number {
  return proxy.count(MESSAGES);
}

test.beforeEach(async ({ timeline }) => {
  test.setTimeout(150_000);
  await timeline.trackRebuilds();
});

test('subscribes once when opening a room on mobile', async ({
  page,
  app,
  timeline,
  proxiedLogin,
}) => {
  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Mobile open ${String(Date.now())}` });
  await account.sendMessage(roomId, 'Welcome to the room');
  await page.setViewportSize({ width: 390, height: 420 });

  await app.openRoom(roomId);

  await expect(timeline.message('Welcome to the room')).toBeVisible({ timeout: 20_000 });
  const built = await timeline.rebuilds();
  await expect.poll(() => timeline.rebuilds(), { timeout: 3_000 }).toBe(built);
});

test('subscribes once and loads initial room history', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Opening fill ${String(Date.now())}` });
  for (let index = 0; index < 60; index += 1) {
    await account.sendMessage(roomId, `Fill message ${String(index)}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  homeserverProxy.clearRequests();

  await app.openRoom(roomId);
  await expect(timeline.message('Fill message 59')).toBeVisible({ timeout: 20_000 });

  await expect.poll(() => pages(homeserverProxy)).toBeGreaterThan(0);
  const settled = pages(homeserverProxy);

  // The prefetch fires on a settle, so a passing poll above proves nothing yet.
  await expect.poll(() => pages(homeserverProxy), { timeout: 3_000 }).toBe(settled);
  const built = await timeline.rebuilds();
  await expect.poll(() => timeline.rebuilds(), { timeout: 3_000 }).toBe(built);
});

test('does not resubscribe the timeline after a room refresh', async ({
  page,
  app,
  timeline,
  proxiedLogin,
}) => {
  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Refresh ${String(Date.now())}` });
  await account.sendMessage(roomId, 'Welcome to the room');
  const last = `Latest before refresh ${String(Date.now())}`;
  await account.sendMessage(roomId, last);

  await app.openRoom(roomId);
  await expect(timeline.message('Welcome to the room')).toBeVisible({ timeout: 20_000 });
  const beforeReload = await timeline.rebuilds();

  await page.reload();

  await expect(timeline.message('Welcome to the room')).toBeVisible({ timeout: 20_000 });
  await timeline.expectAtLatest(last);
  await expect.poll(() => timeline.rebuilds(), { timeout: 3_000 }).toBe(beforeReload);
});

test('keeps the active timeline while crossing the layout breakpoint', async ({
  page,
  app,
  timeline,
  proxiedLogin,
}) => {
  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Breakpoint ${String(Date.now())}` });
  await account.sendMessage(roomId, 'Welcome to the room');
  await page.setViewportSize({ width: 1280, height: 900 });

  await app.openRoom(roomId);
  await expect(timeline.message('Welcome to the room')).toBeVisible({ timeout: 20_000 });
  const built = await timeline.rebuilds();

  await page.setViewportSize({ width: 390, height: 844 });

  await expect(timeline.message('Welcome to the room')).toBeVisible();
  await expect.poll(() => timeline.rebuilds(), { timeout: 3_000 }).toBe(built);
});

test('prefetches history within the oldest timeline items', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Prefetch ${String(Date.now())}` });
  for (let index = 0; index < 80; index += 1) {
    await account.sendMessage(roomId, `Prefetch message ${String(index)}`);
  }
  await page.setViewportSize({ width: 1280, height: 420 });

  await app.openRoom(roomId);
  await expect(timeline.message('Prefetch message 79')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  homeserverProxy.clearRequests();

  await timeline.scrollToAndNotify(await timeline.prefetchBand());
  await expect(timeline.viewport).not.toHaveJSProperty('scrollTop', 0);

  await timeline.wheelUp(100);

  await expect.poll(() => pages(homeserverProxy), { timeout: 20_000 }).toBeGreaterThan(0);
});

test('anchors each history page requested by separate upward gestures', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Gestures ${String(Date.now())}` });
  for (let index = 0; index < 120; index += 1) {
    await account.sendMessage(roomId, `Gesture message ${String(index)}`);
  }
  await page.setViewportSize({ width: 1280, height: 420 });

  await app.openRoom(roomId);
  await expect(timeline.message('Gesture message 119')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  homeserverProxy.clearRequests();

  homeserverProxy.delay(MESSAGES, 600, { times: 6 });

  await timeline.scrollTo(0);
  await timeline.wheelUp(200);
  await timeline.waitForScrollSettled();
  const firstPageAnchor = await timeline.fullyVisibleAnchor();

  await expect.poll(() => pages(homeserverProxy), { timeout: 20_000 }).toBe(1);
  // A second page must need a second gesture, so idling cannot produce one.
  await expect.poll(() => pages(homeserverProxy), { timeout: 3_000 }).toBe(1);
  await expect(timeline.viewport).not.toHaveJSProperty('scrollTop', 0);
  await timeline.expectAnchorHeld(firstPageAnchor, { tolerance: 2 });

  await timeline.scrollTo(0);
  await timeline.wheelUp(200);
  await timeline.waitForScrollSettled();
  const secondPageAnchor = await timeline.fullyVisibleAnchor();

  await expect.poll(() => pages(homeserverProxy), { timeout: 20_000 }).toBe(2);
  await timeline.expectAnchorHeld(secondPageAnchor, { tolerance: 2 });
});
