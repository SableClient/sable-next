import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

function instrumentSelfWrites(viewport: HTMLElement): void {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (!descriptor?.get || !descriptor.set) throw new Error('scrollTop is not an accessor');
  const read = (element: Element): number => Number(descriptor.get?.call(element));
  const write = (element: Element, value: number): void => descriptor.set?.call(element, value);
  const record = { writes: 0 };
  Object.defineProperty(window, '__e2eSelfWrites', {
    configurable: true,
    get: () => record.writes,
    set: (value: number) => {
      record.writes = value;
    },
  });
  const clampTo = (element: Element, target: number): number =>
    Math.min(Math.max(target, 0), element.scrollHeight - element.clientHeight);
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return read(this);
    },
    set(this: Element, value: number) {
      record.writes += clampTo(this, value) - read(this);
      write(this, value);
    },
  });
  viewport.scrollBy = function scrollBy(this: Element, x: number, y: number) {
    const before = read(this);
    record.writes += clampTo(this, before + y) - before;
    Element.prototype.scrollBy.call(this, x, y);
  } as typeof viewport.scrollBy;
}

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
    const sampling = timeline.viewport.evaluate(async (viewport, wheel) => {
      const bounds = viewport.getBoundingClientRect();
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>('.item[data-event-id]'));
      const anchor = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
      if (!anchor) throw new Error('no fully visible row to anchor on');
      const content = anchor.firstElementChild ?? anchor;
      window.__e2eSelfWrites = 0;
      let top = content.getBoundingClientRect().top;
      let scrollTop = viewport.scrollTop;
      let writes = 0;
      let frameError = 0;
      let readerMovement = 0;
      let clamped = viewport.scrollTop === 0;
      let quiet = 0;
      let moved = false;
      for (let frame = 0; frame < 60 && (!moved || quiet < 6); frame += 1) {
        await new Promise(requestAnimationFrame);
        if (!anchor.isConnected) throw new Error('the row the reader was on was unmounted');
        const nextTop = content.getBoundingClientRect().top;
        const nextScrollTop = viewport.scrollTop;
        const nextWrites = window.__e2eSelfWrites;
        const byReader = nextScrollTop - scrollTop - (nextWrites - writes);
        frameError = Math.max(frameError, Math.abs(nextTop - top + byReader));
        readerMovement += byReader;
        if (nextScrollTop === 0) clamped = true;
        if (byReader !== 0) moved = true;
        quiet = byReader === 0 ? quiet + 1 : 0;
        top = nextTop;
        scrollTop = nextScrollTop;
        writes = nextWrites;
      }
      return { frameError, readerMovement, clamped, moved, wheel };
    }, WHEEL);
    await page.mouse.wheel(0, -WHEEL);
    const result = await sampling;
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
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 420 });
  await app.openRoom('!room:example.test', { settled: false });
  await expect(timeline.container).toBeAttached();
  const report = await page.evaluate(async () => {
    const container = document.querySelector<HTMLElement>('.timeline-viewport');
    const viewport = document.querySelector<HTMLElement>('.timeline-viewport .viewport');
    if (!container || !viewport) throw new Error('timeline not mounted');
    const deadline = performance.now() + 10_000;
    while (container.classList.contains('initial')) {
      if (performance.now() > deadline) throw new Error('timeline never revealed');
      await new Promise(requestAnimationFrame);
    }
    const gaps: number[] = [];
    const firstRowTops: number[] = [];
    let hiddenAgain = false;
    const first = (): HTMLElement | null => {
      const bounds = viewport.getBoundingClientRect();
      return (
        Array.from(viewport.querySelectorAll<HTMLElement>('.item')).find(
          (row) => row.getBoundingClientRect().bottom > bounds.top
        ) ?? null
      );
    };
    const firstRow = first();
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise(requestAnimationFrame);
      if (container.classList.contains('initial')) hiddenAgain = true;
      gaps.push(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
      if (firstRow?.isConnected) firstRowTops.push(firstRow.getBoundingClientRect().top);
    }
    return { gaps, firstRowTops, hiddenAgain };
  });
  expect(report.hiddenAgain).toBe(false);
  expect(Math.max(...report.gaps)).toBeLessThanOrEqual(1);
  expect(Math.max(...report.firstRowTops) - Math.min(...report.firstRowTops)).toBeLessThanOrEqual(
    1
  );
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
      const sampling = timeline.viewport.evaluate(async (viewport, travel) => {
        const bounds = viewport.getBoundingClientRect();
        const anchor = Array.from(
          viewport.querySelectorAll<HTMLElement>('.item[data-event-id]')
        ).find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
        });
        if (!anchor) throw new Error('no fully visible row to anchor on');
        const content = anchor.firstElementChild ?? anchor;
        window.__e2eSelfWrites = 0;
        let top = content.getBoundingClientRect().top;
        let scrollTop = viewport.scrollTop;
        let writes = 0;
        let frameError = 0;
        let readerMovement = 0;
        let clamped = scrollTop === 0;
        let moved = false;
        let quiet = 0;
        for (let frame = 0; frame < 300 && (!moved || quiet < 12); frame += 1) {
          await new Promise(requestAnimationFrame);
          if (!anchor.isConnected) throw new Error('the row the reader was on was unmounted');
          const nextTop = content.getBoundingClientRect().top;
          const nextScrollTop = viewport.scrollTop;
          const nextWrites = window.__e2eSelfWrites;
          const byReader = nextScrollTop - scrollTop - (nextWrites - writes);
          frameError = Math.max(frameError, Math.abs(nextTop - top + byReader));
          readerMovement += byReader;
          if (nextScrollTop === 0) clamped = true;
          if (byReader !== 0) moved = true;
          quiet = byReader === 0 ? quiet + 1 : 0;
          top = nextTop;
          scrollTop = nextScrollTop;
          writes = nextWrites;
        }
        return { frameError, readerMovement, clamped, moved, travel };
      }, STEP * STEPS);

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

      const result = await sampling;
      worstFrame = Math.max(worstFrame, result.frameError);
      if (!result.clamped && Math.abs(result.readerMovement + result.travel) > STEP) {
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
  expect(Math.max(...gaps.slice(1))).toBeLessThanOrEqual(1);
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
