// The failure is a sustained scroll back through many pages, not one prepend, so
// every page is asserted and the anchor is sampled per frame: a settled-state
// check cannot see a mid-flight jump.

import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { HomeserverProxy } from './fixtures/proxy';

const MESSAGES = /GET \/_matrix\/client\/v[13]\/rooms\/[^ ]*\/messages/;
const PAGES = 4;
const DRIFT = 2;

test.use({ storageState: SIGNED_OUT });

function pages(proxy: HomeserverProxy): number {
  return proxy.count(MESSAGES);
}

async function seedDeepRoom(
  account: import('./fixtures/matrix').MatrixAdmin,
  count: number
): Promise<string> {
  const roomId = await account.createRoom({ name: `Scrollback ${String(Date.now())}` });
  for (let index = 0; index < count; index += 1) {
    await account.sendMessage(
      roomId,
      `Scrollback ${String(index)}${index % 5 === 0 ? ` ${'wraps and wraps '.repeat(4)}` : ''}`
    );
  }
  return roomId;
}

test.fixme('holds the anchor through a long scroll back', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  test.setTimeout(180_000);
  const account = await proxiedLogin();
  const roomId = await seedDeepRoom(account, 200);
  await page.setViewportSize({ width: 1280, height: 420 });

  await app.openRoom(roomId);
  await timeline.expectRevealed();
  homeserverProxy.clearRequests();
  homeserverProxy.delay(MESSAGES, 600, { times: PAGES * 4 });

  for (let round = 0; round < PAGES; round += 1) {
    const before = pages(homeserverProxy);
    do {
      await timeline.wheelUp(240);
    } while ((await timeline.scrollTop()) > (await timeline.prefetchBand()));
    await timeline.waitForScrollSettled();
    const anchor = await timeline.fullyVisibleAnchor();

    const positions = await timeline.sampleAnchorWhile(anchor.itemId, 900, async () => {
      await expect.poll(() => pages(homeserverProxy)).toBeGreaterThan(before);
    });

    expect(positions.length, `page ${String(round)} sampled the anchor zero times`).toBeGreaterThan(
      0
    );
    const drift = Math.max(...positions.map((position) => Math.abs(position - anchor.y)));
    expect(
      drift,
      `page ${String(round)} drifted ${drift.toFixed(1)}px mid-flight`
    ).toBeLessThanOrEqual(DRIFT);
    await expect(
      timeline.itemById(anchor.itemId),
      `page ${String(round)} scrolled the anchored row out of the rendered window`
    ).toHaveCount(1);
    await timeline.expectAnchorHeld(anchor, { tolerance: DRIFT });

    expect(await timeline.scrollTop()).toBeGreaterThan(0);
  }
});

// The row above the reader gains a sender header when the arriving page ends
// with a different sender, and that measurement lands after Svelte has already
// positioned the rows.
test('holds the reader when a prepend regroups the row above them', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  test.setTimeout(180_000);
  const account = await proxiedLogin();
  const roomId = await seedDeepRoom(account, 200);
  await page.setViewportSize({ width: 1280, height: 420 });

  await app.openRoom(roomId);
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  homeserverProxy.clearRequests();
  homeserverProxy.delay(MESSAGES, 600, { times: 4 });

  const before = pages(homeserverProxy);
  do {
    await timeline.wheelUp(240);
  } while ((await timeline.scrollTop()) > (await timeline.prefetchBand()));
  await timeline.waitForScrollSettled();

  const anchor = await timeline.fullyVisibleAnchor();
  const positions = await timeline.sampleAnchorWhile(anchor.itemId, 900, async () => {
    await expect.poll(() => pages(homeserverProxy), { timeout: 20_000 }).toBeGreaterThan(before);
  });

  expect(positions.length, 'the anchor was sampled zero times').toBeGreaterThan(0);
  const drift = Math.max(...positions.map((position) => Math.abs(position - anchor.y)));
  expect(drift, `the reader drifted ${drift.toFixed(1)}px mid-flight`).toBeLessThanOrEqual(DRIFT);
  await timeline.expectAnchorHeld(anchor, { tolerance: DRIFT });
});
