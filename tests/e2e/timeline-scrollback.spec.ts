// The failure is a sustained scroll back through many pages, not one prepend, so
// every page is asserted and the anchor is sampled per frame: a settled-state
// check cannot see a mid-flight jump.

import { expect, test } from './fixtures/test';

const PAGES = 12;
const DRIFT = 2;

// Still red, but no longer on the anchor: the second page never arrives, because
// the first fill clears `historyInputArmed` and a wheel gesture does not re-arm
// it while `historyFillActive`. The single-prepend case is asserted below.
test.fixme('holds the anchor through a long scroll back', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('endless_history');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openHome();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect.poll(() => core.subscribeCount()).toBe(1);

  for (let round = 0; round < PAGES; round += 1) {
    const before = await core.paginateCount();
    // A held anchor keeps the reader on their row, so the page just prepended
    // sits entirely above them and one gesture no longer reaches the prefetch
    // band. Wheel until it does, and no further.
    do {
      await timeline.wheelUp(240);
    } while ((await timeline.scrollTop()) > (await timeline.prefetchBand()));
    // The gesture moves the anchor by design. Wait for it to settle so the only
    // movement the sampling below can see is the prepend landing.
    await page.waitForTimeout(200);
    // Not `anchorAt(n, { visibleOnly })`: Playwright counts an overscan row that
    // is scrolled out of sight as visible, and such a row is meant to leave the
    // rendered window when history is prepended.
    const anchor = await timeline.fullyVisibleAnchor();

    const positions = await timeline.sampleAnchorWhile(anchor.itemId, 900, async () => {
      await expect.poll(() => core.paginateCount()).toBeGreaterThan(before);
    });

    // An empty sample set would make `Math.max` return -Infinity and pass.
    expect(positions.length, `page ${String(round)} sampled the anchor zero times`).toBeGreaterThan(
      0
    );
    const drift = Math.max(...positions.map((position) => Math.abs(position - anchor.y)));
    expect(
      drift,
      `page ${String(round)} drifted ${drift.toFixed(1)}px mid-flight`
    ).toBeLessThanOrEqual(DRIFT);
    // Losing the row entirely is the failure worth naming, and asserting it
    // here keeps `expectAnchorHeld` from burning the whole test timeout on a
    // locator that will never resolve.
    await expect(
      timeline.itemById(anchor.itemId),
      `page ${String(round)} scrolled the anchored row out of the rendered window`
    ).toHaveCount(1);
    await timeline.expectAnchorHeld(anchor, { tolerance: DRIFT });

    // Resting at exactly zero leaves the prefetch trigger permanently armed,
    // which is what turns one lost anchor into a run of pages.
    expect(await timeline.scrollTop()).toBeGreaterThan(0);
  }

  // One page per gesture: a cascade would show up here long before the anchor
  // assertions started failing.
  expect(await core.paginateCount()).toBe(PAGES);
});

// The row above the reader gains a sender header when the arriving page ends
// with a different sender, and that measurement lands after Svelte has already
// positioned the rows.
test('holds the reader when a prepend regroups the row above them', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('endless_history');
  await page.setViewportSize({ width: 1280, height: 420 });
  await app.openHome();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect.poll(() => core.subscribeCount()).toBe(1);

  const before = await core.paginateCount();
  do {
    await timeline.wheelUp(240);
  } while ((await timeline.scrollTop()) > (await timeline.prefetchBand()));
  await page.waitForTimeout(200);

  const anchor = await timeline.fullyVisibleAnchor();
  const positions = await timeline.sampleAnchorWhile(anchor.itemId, 900, async () => {
    await expect.poll(() => core.paginateCount()).toBeGreaterThan(before);
  });

  expect(positions.length, 'the anchor was sampled zero times').toBeGreaterThan(0);
  const drift = Math.max(...positions.map((position) => Math.abs(position - anchor.y)));
  expect(drift, `the reader drifted ${drift.toFixed(1)}px mid-flight`).toBeLessThanOrEqual(DRIFT);
  await timeline.expectAnchorHeld(anchor, { tolerance: DRIFT });
});
