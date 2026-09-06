import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';
import { instrumentSelfWrites, startGestureSample } from './fixtures/timeline-probe';
import type { FakeCoreDriver } from './pages/FakeCoreDriver';
import type { RoomTimeline } from './pages/RoomTimeline';

test.use({ storageState: SIGNED_OUT });

async function loadScrollableHistory(core: FakeCoreDriver, timeline: RoomTimeline): Promise<void> {
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'mobile',
        label: 'Mobile history',
        count: 80,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect.poll(() => timeline.scrollableHeight()).toBeGreaterThan(500);
  await timeline.scrollToBottomAndNotify();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  await timeline.waitForScrollSettled();
}

const PROBE_HTML =
  '<div id="probe" style="height:300px;overflow:auto;position:relative"><div style="height:2000px"><div class="item" data-event-id="probe" style="position:absolute;top:600px">Reader</div></div></div>';

test('the gesture sampler catches a scrollTo jump and return', async ({ page }) => {
  await page.setContent(PROBE_HTML);
  const viewport = page.locator('#probe');
  await viewport.evaluate((node) => {
    node.scrollTop = 400;
  });
  await viewport.evaluate(instrumentSelfWrites);
  const sampling = await startGestureSample(viewport, { frames: 20, quietFrames: 6 });
  await viewport.evaluate(async (node) => {
    node.scrollTo(0, 500);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    node.scrollTo({ top: 400 });
  });
  const result = await sampling.finish();
  expect(result.readerMovement).toBe(0);
  expect(result.frameError).toBe(100);
});

test('the gesture sampler flags smooth programmatic scrolling', async ({ page }) => {
  await page.setContent(PROBE_HTML);
  const viewport = page.locator('#probe');
  await viewport.evaluate((node) => {
    node.scrollTop = 400;
  });
  await viewport.evaluate(instrumentSelfWrites);
  const sampling = await startGestureSample(viewport, { frames: 20, quietFrames: 6 });
  await viewport.evaluate((node) => {
    node.scrollTo({ top: 500, behavior: 'smooth' });
  });
  expect((await sampling.finish()).unexpectedScrolls).toEqual(['scrollTo']);
});

test('the anchor sampler reports a row that disappears', async ({ page, timeline }) => {
  await page.setContent(
    '<div class="timeline-viewport"><div class="viewport"><div class="item" data-item-id="probe">Reader</div></div></div>'
  );
  const positions = await timeline.sampleAnchorWhile('probe', 120, async () => {
    await timeline.itemById('probe').evaluate((node) => {
      node.remove();
    });
  });
  expect(positions).toContain(Number.POSITIVE_INFINITY);
});

test('the gesture sampler keeps sampling between input events', async ({ page }) => {
  await page.setContent(PROBE_HTML);
  const viewport = page.locator('#probe');
  await viewport.evaluate((node) => {
    node.scrollTop = 400;
  });
  await viewport.evaluate(instrumentSelfWrites);
  const sampling = await startGestureSample(viewport, { frames: 60, quietFrames: 2 });
  await viewport.evaluate(async (node) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (!descriptor?.set) throw new Error('missing native scrollTop setter');
    descriptor.set.call(node, 500);
    for (let frame = 0; frame < 6; frame += 1) await new Promise(requestAnimationFrame);
    descriptor.set.call(node, 600);
  });
  const result = await sampling.finish();
  expect(result.readerMovement).toBe(200);
  expect(result.frameError).toBe(0);
});

test('latest stays at the bottom on every frame as message heights settle', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  const gaps = await timeline.viewport.evaluate(async (viewport) => {
    const gaps: number[] = [];
    const last = viewport.querySelector<HTMLElement>('.item:last-child');
    if (!last) throw new Error('no latest row');
    last.style.paddingBottom = '120px';
    await new Promise(requestAnimationFrame);
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise(requestAnimationFrame);
      gaps.push(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
    }
    return gaps;
  });
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1);
});

test('late row measurements above the reader never move the visible message', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await timeline.scrollAboveBottomAndNotify(150);
  await timeline.waitForScrollSettled();
  const anchor = await timeline.fullyVisibleAnchor();
  const positions = await timeline.sampleAnchorWhile(anchor.itemId, 500, async () => {
    await timeline.viewport.evaluate((viewport) => {
      const top = viewport.getBoundingClientRect().top;
      const above = Array.from(viewport.querySelectorAll<HTMLElement>('.item')).filter(
        (row) => row.getBoundingClientRect().bottom < top
      );
      if (!above.length) throw new Error('no overscanned rows above reader');
      for (const row of above) row.style.paddingBottom = '120px';
    });
  });
  expect(Math.max(...positions.map((top) => Math.abs(top - anchor.y)))).toBeLessThanOrEqual(2);
});

test('large history pages never displace or unmount the visible reader', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await timeline.scrollToAndNotify(200);
  await timeline.waitForScrollSettled();
  const subscription = await core.subscription();
  const anchor = await timeline.fullyVisibleAnchor();
  for (let round = 0; round < 4; round += 1) {
    const values = historyItems({
      idPrefix: `page-${String(round)}`,
      label: 'History',
      count: 80,
      timestampBase: 1_699_999_000_000 - round * 1_000,
      body: (index) => `History ${String(index)} ${'wrapping content '.repeat((index % 5) * 20)}`,
    });
    const positions = await core.sampleAnchorWhile(
      anchor.itemId,
      subscription,
      values.map((value, index) => ({ op: 'insert', index: index + 1, value })),
      500
    );
    expect(Math.max(...positions.map((top) => Math.abs(top - anchor.y)))).toBeLessThanOrEqual(2);
    await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
  }
});

test('reading just above latest stays fixed when typing shrinks the viewport', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  await timeline.scrollAboveBottomAndNotify(30);
  await timeline.waitForScrollSettled();
  await expect(timeline.jumpToLatest).toBeVisible();
  const anchor = await timeline.fullyVisibleAnchor();
  const positions = await timeline.sampleAnchorWhile(anchor.itemId, 400, async () => {
    await core.emitTyping('!room:example.test', ['@alice:example.test']);
  });
  expect(Math.max(...positions.map((top) => Math.abs(top - anchor.y)))).toBeLessThanOrEqual(2);
  await expect(timeline.jumpToLatest).toBeVisible();
});

test('scrolling through unmeasured history preserves the requested movement every frame', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 600 });
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  const subscription = await core.subscription();
  const items = historyItems({
    idPrefix: 'variable',
    label: 'Variable history',
    count: 250,
    timestampBase: 1_699_999_000_000,
    body: (index) =>
      `Message ${String(index)} ${'long wrapping content '.repeat((index % 5) * 25)}`,
  });
  await core.emitTimelineDiff(subscription, [{ op: 'reset', values: items }]);
  await timeline.scrollToBottomAndNotify();
  await timeline.waitForScrollSettled();

  const drift = await timeline.viewport.evaluate(async (viewport) => {
    const errors: number[] = [];
    for (let step = 0; step < 80; step += 1) {
      const bounds = viewport.getBoundingClientRect();
      const anchor = Array.from(viewport.querySelectorAll<HTMLElement>('.item')).find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      if (!anchor) throw new Error('scrolling left the viewport blank');
      const top = anchor.getBoundingClientRect().top;
      const before = viewport.scrollTop;
      viewport.scrollTop -= 45;
      const movement = before - viewport.scrollTop;
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise(requestAnimationFrame);
        if (!anchor.isConnected) throw new Error('scrolling discarded a visible anchor');
        errors.push(Math.abs(anchor.getBoundingClientRect().top - top - movement));
      }
    }
    return Math.max(...errors);
  });

  expect(drift, 'layout corrections must preserve the reader’s scroll').toBeLessThanOrEqual(2);
});

test('real wheel input through unmeasured history moves the reader by exactly the wheel', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('endless_history');
  await page.setViewportSize({ width: 900, height: 600 });
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  await timeline.viewport.hover();

  await timeline.viewport.evaluate(instrumentSelfWrites);

  await page.evaluate(() => new Promise(requestAnimationFrame));
  const WHEEL = 120;
  const TICKS = 25;
  let worstFrame = 0;
  let worstTick = 0;
  const misses: object[] = [];
  let dropped = 0;
  for (let tick = 0; tick < TICKS; tick += 1) {
    await timeline.viewport.evaluate((node) => {
      node.dataset.wheelReceived = 'false';
      node.addEventListener(
        'wheel',
        () => {
          node.dataset.wheelReceived = 'true';
        },
        { once: true }
      );
    });
    const sampling = await startGestureSample(timeline.viewport, {
      frames: 300,
      quietFrames: 6,
    });
    await page.mouse.wheel(0, -WHEEL);
    await expect(timeline.viewport).toHaveAttribute('data-wheel-received', 'true');
    const result = await sampling.finish();
    expect(result.unexpectedScrolls, 'smooth commands must not fight the wheel').toEqual([]);
    worstFrame = Math.max(worstFrame, result.frameError);
    if (!result.moved && !result.clamped) {
      dropped += 1;
      continue;
    }
    const missed = result.clamped ? 0 : Math.abs(result.readerMovement + WHEEL);
    if (missed > 2 || result.frameError > 2) {
      misses.push({ tick, pages: await core.paginateCount(), ...result });
    }
    worstTick = Math.max(worstTick, missed);
  }
  expect(dropped, 'the input pipeline dropped too many wheel notches').toBeLessThanOrEqual(2);
  expect(misses, 'wheel notches the reader did not receive in full').toEqual([]);

  expect(worstFrame, 'a row moved on screen by more than the reader scrolled').toBeLessThanOrEqual(
    2
  );
  expect(worstTick, 'a wheel notch was not honoured in full').toBeLessThanOrEqual(2);
  expect(await core.paginateCount()).toBeGreaterThanOrEqual(2);
});

test('a second history page landing during the first hold keeps the reader fixed', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await timeline.scrollToAndNotify(200);
  await timeline.waitForScrollSettled();
  const subscription = await core.subscription();
  const anchor = await timeline.fullyVisibleAnchor();
  const pages = [0, 1].map((round) =>
    historyItems({
      idPrefix: `overlap-${String(round)}`,
      label: 'Overlap',
      count: 80,
      timestampBase: 1_699_998_000_000 - round * 1_000,
      body: (index) => `Overlap ${String(index)} ${'wrapping content '.repeat((index % 5) * 20)}`,
    }).map((value, index) => ({ op: 'insert', index: index + 1, value }))
  );

  const positions = await page.evaluate(
    async ({ itemId, subscription, pages }) => {
      const positions: number[] = [];
      const sample = (): void => {
        const row = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`);
        positions.push(row ? row.getBoundingClientRect().top : Number.POSITIVE_INFINITY);
      };
      sample();
      window.__e2eEmitTimelineEvent({ type: 'timeline_diff', subscription, diffs: pages[0] });
      window.setTimeout(() => {
        window.__e2eEmitTimelineEvent({ type: 'timeline_diff', subscription, diffs: pages[1] });
      }, 50);
      const deadline = performance.now() + 700;
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        sample();
      }
      return positions;
    },
    { itemId: anchor.itemId, subscription, pages }
  );

  expect(Math.max(...positions.map((top) => Math.abs(top - anchor.y)))).toBeLessThanOrEqual(2);
  await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
});

test('the reveal is final: nothing moves in the first second after the room opens', async ({
  page,
  isMobile,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  if (!isMobile) await page.setViewportSize({ width: 900, height: 420 });
  await page.addInitScript(() => {
    window.__e2eRevealReport = new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const container = document.querySelector<HTMLElement>('.timeline-viewport:not(.initial)');
        const viewport = container?.querySelector<HTMLElement>('.viewport');
        if (!container || !viewport) return;
        observer.disconnect();
        const bounds = viewport.getBoundingClientRect();
        const first = Array.from(viewport.querySelectorAll<HTMLElement>('.item')).find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        if (!first) {
          reject(new Error('revealed an empty viewport'));
          return;
        }
        const content = first.querySelector('.message-main') ?? first;
        const report = { gaps: [] as number[], readerTops: [] as number[], hiddenAgain: false };
        const sample = (): void => {
          report.hiddenAgain ||= container.classList.contains('initial');
          report.gaps.push(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
          report.readerTops.push(
            content.isConnected ? content.getBoundingClientRect().top : Number.POSITIVE_INFINITY
          );
        };
        sample();
        const deadline = performance.now() + 1_000;
        const frame = (): void => {
          sample();
          if (performance.now() < deadline) requestAnimationFrame(frame);
          else resolve(report);
        };
        requestAnimationFrame(frame);
      });
      observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    });
  });
  await app.openRoom('!room:example.test', { settled: false });
  await timeline.expectRevealed({ timeout: 30_000 });
  const report = await page.evaluate(() => window.__e2eRevealReport);
  expect(report.hiddenAgain).toBe(false);
  expect(
    Math.max(...report.gaps),
    `Bottom gaps: ${JSON.stringify(report.gaps)}`
  ).toBeLessThanOrEqual(1);
  expect(Math.max(...report.readerTops) - Math.min(...report.readerTops)).toBeLessThanOrEqual(1);
});

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('a finger drag through unmeasured history moves the reader by exactly the drag', async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'touch input is driven through CDP');
    await installRoomCore('endless_history');
    await app.openRoom('!room:example.test');
    await timeline.expectRevealed();
    await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
    const box = await timeline.viewport.boundingBox();
    if (!box) throw new Error('viewport has no bounds');
    const x = box.x + box.width / 2;
    const startY = box.y + box.height * 0.3;
    const client = await page.context().newCDPSession(page);

    await timeline.viewport.evaluate(instrumentSelfWrites);

    const STEP = 24;
    const STEPS = 12;
    const DRAGS = 8;
    const misses: object[] = [];
    let worstFrame = 0;
    for (let drag = 0; drag < DRAGS; drag += 1) {
      const sampling = await startGestureSample(timeline.viewport, {
        frames: 300,
        quietFrames: 12,
      });

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: startY }],
      });
      for (let step = 1; step <= STEPS; step += 1) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: startY + step * STEP }],
        });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(120);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

      const result = await sampling.finish();
      expect(result.unexpectedScrolls, 'smooth commands must not fight the finger').toEqual([]);
      worstFrame = Math.max(worstFrame, result.frameError);
      if (!result.clamped && Math.abs(result.readerMovement + STEP * STEPS) > STEP) {
        misses.push({ drag, pages: await core.paginateCount(), ...result });
      }
    }

    expect(misses, 'drags the reader did not receive in full').toEqual([]);
    expect(worstFrame, 'a row moved on screen by more than the finger dragged').toBeLessThanOrEqual(
      2
    );
    expect(await core.paginateCount()).toBeGreaterThanOrEqual(2);
  });
});

test.describe('mobile', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'Requires a mobile browser profile');
  });

  test('jump to latest respects reduced motion', async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await loadScrollableHistory(core, timeline);
    await timeline.scrollAboveBottomAndNotify(200);
    await expect(timeline.jumpToLatest).toBeVisible();
    const gap = await timeline.jumpToLatest.evaluate((button) => {
      (button as HTMLElement).click();
      const node = document.querySelector<HTMLElement>('.timeline-viewport .viewport');
      if (!node) throw new Error('missing timeline viewport');
      return node.scrollHeight - node.clientHeight - node.scrollTop;
    });
    expect(gap).toBeLessThanOrEqual(1);
    await expect(timeline.jumpToLatest).toBeHidden();
  });

  test('latest remains visible through keyboard-sized viewport changes', async ({
    page,
    app,
    timeline,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
    await app.composer.focus();
    const size = page.viewportSize();
    if (!size) throw new Error('missing mobile viewport');
    await page.setViewportSize({ width: size.width, height: size.height - 300 });
    await timeline.expectAtLatest('General message 19');
    await page.setViewportSize(size);
    await timeline.expectAtLatest('General message 19');
    expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  });

  test('opening and closing the keyboard preserves a reader in history', async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await loadScrollableHistory(core, timeline);
    await timeline.scrollAboveBottomAndNotify(200);
    await timeline.waitForScrollSettled();
    await expect(timeline.jumpToLatest).toBeVisible();
    const anchor = await timeline.fullyVisibleAnchor();
    const size = page.viewportSize();
    if (!size) throw new Error('missing mobile viewport');
    await app.composer.focus();
    await page.setViewportSize({ width: size.width, height: size.height - 300 });
    await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
    await page.setViewportSize(size);
    await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
    await expect(timeline.jumpToLatest).toBeVisible();
  });

  test('rotating the viewport preserves the reader’s position within the timeline', async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await loadScrollableHistory(core, timeline);
    await timeline.scrollAboveBottomAndNotify(200);
    await timeline.waitForScrollSettled();
    await expect(timeline.jumpToLatest).toBeVisible();
    const anchor = await timeline.fullyVisibleAnchor();
    const before = await timeline.viewport.boundingBox();
    const size = page.viewportSize();
    if (!size || !before) throw new Error('missing mobile viewport');
    await page.setViewportSize({ width: size.height, height: size.width });
    await expect
      .poll(async () => {
        const row = await timeline.itemById(anchor.itemId).boundingBox();
        const viewport = await timeline.viewport.boundingBox();
        return row && viewport ? Math.abs(row.y - viewport.y - (anchor.y - before.y)) : Infinity;
      })
      .toBeLessThanOrEqual(2);
  });

  test('jump to latest finishes and resumes following incoming messages', async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await loadScrollableHistory(core, timeline);
    await timeline.scrollAboveBottomAndNotify(200);
    await expect(timeline.jumpToLatest).toBeVisible();
    const before = await timeline.scrollTop();
    const end = await timeline.scrollableHeight();
    const sampling = timeline.viewport.evaluate(async (node) => {
      const offsets: number[] = [];
      for (let frame = 0; frame < 30; frame += 1) {
        await new Promise(requestAnimationFrame);
        offsets.push(node.scrollTop);
      }
      return offsets;
    });
    await timeline.jumpToLatest.tap();
    const offsets = await sampling;
    expect(
      offsets.some((offset) => offset > before + 1 && offset < end - 1),
      'the requested smooth jump should render intermediate positions'
    ).toBe(true);
    await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
    const subscription = await core.subscription();
    await core.emitTimelineDiff(subscription, [
      { op: 'push_back', value: timelineItem('mobile-incoming', 'Mobile incoming') },
    ]);
    await timeline.expectAtLatest('Mobile incoming');
    await expect(timeline.jumpToLatest).toBeHidden();
  });
});

test('a message the reader sends from the bottom is followed on every frame', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  const subscription = await core.subscription();
  const echo = {
    ...timelineItem('sent-from-bottom', `A message I just sent ${'that wraps '.repeat(30)}`),
    event_id: null,
    transaction_id: 'txn-sent-from-bottom',
    is_own: true,
  };
  const gaps = await page.evaluate(
    async ({ subscription, echo }) => {
      const viewport = document.querySelector<HTMLElement>('.timeline-viewport .viewport');
      if (!viewport) throw new Error('no viewport');
      const gaps: number[] = [];
      window.__e2eEmitTimelineEvent({
        type: 'timeline_diff',
        subscription,
        diffs: [{ op: 'push_back', value: echo }],
      });
      for (let frame = 0; frame < 30; frame += 1) {
        await new Promise(requestAnimationFrame);
        gaps.push(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
      }
      return gaps;
    },
    { subscription, echo }
  );
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1);
  await expect(timeline.itemById('sent-from-bottom')).toBeInViewport();
});

test('an incoming message never moves a reader who is reading history', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await timeline.scrollToAndNotify(200);
  await timeline.waitForScrollSettled();
  const subscription = await core.subscription();
  const anchor = await timeline.fullyVisibleAnchor();
  const positions = await core.sampleAnchorWhile(
    anchor.itemId,
    subscription,
    [{ op: 'push_back', value: timelineItem('incoming-while-reading', 'Incoming while reading') }],
    400
  );
  expect(Math.max(...positions.map((top) => Math.abs(top - anchor.y)))).toBeLessThanOrEqual(1);
});

test('a message sent while reading history leaves the reader in place', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test');
  await timeline.scrollToAndNotify(200);
  await timeline.waitForScrollSettled();
  await expect(timeline.jumpToLatest).toBeVisible();
  const subscription = await core.subscription();
  const anchor = await timeline.fullyVisibleAnchor();
  const positions = await core.sampleAnchorWhile(
    anchor.itemId,
    subscription,
    [
      {
        op: 'push_back',
        value: {
          ...timelineItem('sent-from-history', 'A message I sent while reading'),
          event_id: null,
          transaction_id: 'txn-sent-from-history',
          is_own: true,
        },
      },
    ],
    400
  );
  expect(Math.max(...positions.map((top) => Math.abs(top - anchor.y)))).toBeLessThanOrEqual(1);
  await expect(timeline.jumpToLatest).toBeVisible();
});
