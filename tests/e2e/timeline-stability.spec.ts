import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';
import { instrumentSelfWrites, startGestureSample } from './fixtures/timeline-probe';
import type { FakeCoreDriver } from './pages/FakeCoreDriver';
import type { RoomTimeline } from './pages/RoomTimeline';

test.use({ storageState: SIGNED_OUT });

for (const { fits, touching } of [
  { fits: false, touching: false },
  { fits: true, touching: false },
  { fits: false, touching: true },
  { fits: true, touching: true },
]) {
  test(`viewport expansion hides the bottom button without a gap (${fits ? 'all content fits' : 'overflowing content'}, ${touching ? 'touch held' : 'no touch'})`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await loadScrollableHistory(core, timeline);
    const size = page.viewportSize();
    if (!size) throw new Error('missing viewport size');
    const dimensions = await timeline.viewport.evaluate((node) => ({
      height: node.clientHeight,
      content: node.scrollHeight,
    }));
    await timeline.scrollAboveBottomAndNotify(dimensions.height / 4);
    await timeline.waitForScrollSettled();
    await expect(timeline.jumpToLatest).toBeVisible();
    if (touching) {
      await timeline.viewport.dispatchEvent('touchstart', {
        touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
      });
      await timeline.viewport.evaluate(instrumentSelfWrites);
    }
    await page.setViewportSize({
      width: size.width,
      height: Math.ceil(size.height + (fits ? dimensions.content : dimensions.height / 2)),
    });
    await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
    await expect(timeline.jumpToLatest).toBeHidden();
    const gap = await timeline.viewport.evaluate((viewport) => {
      const content = viewport.querySelector('.window-rows');
      if (!content) throw new Error('missing timeline content');
      return viewport.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom;
    });
    expect(Math.abs(gap)).toBeLessThanOrEqual(1);
    if (touching) {
      expect(await page.evaluate(() => window.__e2eSelfWriteCount)).toBe(0);
      await timeline.viewport.dispatchEvent('touchend', { touches: [] });
      await timeline.waitForScrollSettled();
    }
    await page.setViewportSize(size);
    await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
    await expect(timeline.jumpToLatest).toBeHidden();
  });
}

test('touch keyboard resize keeps following latest during a partial scroll adjustment', async ({
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await loadScrollableHistory(core, timeline);
  await timeline.waitForScrollSettled();
  await expect(timeline.jumpToLatest).toBeHidden();
  await app.composer.focus();
  await timeline.viewport.evaluate((node) => {
    node.style.maxHeight = '50%';
    const remaining = node.scrollHeight - node.clientHeight - node.scrollTop;
    if (remaining <= 0) throw new Error('timeline viewport did not shrink');
    node.scrollTop += remaining / 2;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(timeline.jumpToLatest).toBeHidden();
  await timeline.waitForScrollSettled();
  await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
  await expect(timeline.jumpToLatest).toBeHidden();
});

for (const reading of [false, true]) {
  test(`touch repeated keyboard resizing preserves ${reading ? 'the reader' : 'latest'} with incoming messages and late measurements`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await loadScrollableHistory(core, timeline);
    if (reading) {
      const height = await timeline.viewport.evaluate((node) => node.clientHeight);
      await timeline.scrollAboveBottomAndNotify(height * 2);
    }
    await timeline.waitForScrollSettled();
    const anchor = reading ? await timeline.fullyVisibleAnchor() : null;
    const size = page.viewportSize();
    if (!size) throw new Error('missing viewport size');
    const subscription = await core.subscription();
    await app.composer.focus();
    for (const [index, ratio] of [0.65, 0.5, 1].entries()) {
      await page.setViewportSize({ width: size.width, height: Math.round(size.height * ratio) });
      await core.emitTimelineDiff(subscription, [
        {
          op: 'push_back',
          value: timelineItem(`keyboard-cycle-${index}`, 'Incoming during keyboard resize'),
        },
      ]);
      await timeline.viewport.evaluate((node) => {
        const row = node.querySelector<HTMLElement>('.item');
        if (!row) throw new Error('missing row to resize');
        row.style.paddingBottom = '4rem';
      });
      await timeline.waitForScrollSettled();
      if (anchor) {
        await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
        await expect(timeline.jumpToLatest).toBeVisible();
      } else {
        await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
        await expect(timeline.itemById(`keyboard-cycle-${index}`)).toBeInViewport();
        await expect(timeline.jumpToLatest).toBeHidden();
      }
    }
  });
}

test('touch navigation to a distant latest message never renders a blank frame', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'distant',
        label: 'Distant',
        count: 1000,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect(timeline.itemById('distant-999')).toBeInViewport();
  await timeline.scrollToAndNotify(0);
  await expect(timeline.itemById('distant-0')).toBeInViewport();
  await timeline.waitForScrollSettled();
  await expect(timeline.jumpToLatest).toBeVisible();
  const blankFrames = await timeline.jumpToLatest.evaluate(async (button) => {
    const viewport = document.querySelector('.timeline-viewport .viewport');
    if (!viewport) throw new Error('missing timeline viewport');
    (button as HTMLElement).click();
    let blank = 0;
    for (let frame = 0; frame < 60; frame++) {
      await new Promise(requestAnimationFrame);
      const bounds = viewport.getBoundingClientRect();
      if (
        !Array.from(viewport.querySelectorAll('.item')).some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        })
      )
        blank++;
    }
    return blank;
  });
  expect(blankFrames).toBe(0);
  await expect(timeline.itemById('distant-999')).toBeInViewport();
});

test('continuous touch reaches taller older history without a false boundary', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.addStyleTag({ content: '.item[data-item-id^="tall-"] { min-height: 400px; }' });
  const values = historyItems({
    idPrefix: 'short',
    label: 'History',
    count: 1000,
    timestampBase: 1_699_999_000_000,
  });
  for (let index = 0; index < 900; index++) values[index].id = `tall-${index}`;
  await core.emitTimelineDiff(await core.subscription(), [{ op: 'reset', values }]);
  await expect(timeline.itemById('short-999')).toBeInViewport();
  await timeline.waitForScrollSettled();
  await timeline.viewport.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
  });
  const result = await timeline.viewport.evaluate(async (viewport) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (!descriptor?.set) throw new Error('missing native scrollTop setter');
    let blank = false;
    let drift = 0;
    let maxRows = 0;
    let reachedStart = false;
    for (let frame = 0; frame < 500; frame++) {
      const bounds = viewport.getBoundingClientRect();
      descriptor.set.call(viewport, viewport.scrollTop - 1000);
      const anchor = Array.from(viewport.querySelectorAll('.item')).find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      const content = anchor?.firstElementChild ?? anchor;
      const top = content?.getBoundingClientRect().top;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      if (content && top !== undefined)
        drift = Math.max(
          drift,
          content.isConnected ? Math.abs(content.getBoundingClientRect().top - top) : Infinity
        );
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>('.item'));
      maxRows = Math.max(maxRows, rows.length);
      const visible = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      blank ||= visible.length === 0;
      reachedStart = visible.some((row) => row.dataset.itemId === 'tall-0');
      if (reachedStart) break;
    }
    return { blank, drift, maxRows, reachedStart };
  });
  await timeline.viewport.dispatchEvent('touchend', { touches: [] });
  expect(result.reachedStart).toBe(true);
  expect(result.blank).toBe(false);
  expect(result.drift).toBeLessThanOrEqual(2);
  expect(result.maxRows).toBeLessThanOrEqual(120);
});

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

test('anchor identity and position come from the same rendered row', async ({ page, timeline }) => {
  await page.setContent(
    '<div class="timeline-viewport"><div class="viewport"><div class="item" data-item-id="first" style="position:absolute;top:2rem">First</div><div class="item" data-item-id="reader" style="position:absolute;top:6rem">Reader</div></div></div>'
  );
  const positions = await timeline.items.evaluateAll((nodes) =>
    Object.fromEntries<number>(
      nodes.map(
        (node) =>
          [node.getAttribute('data-item-id') ?? '', node.getBoundingClientRect().top] as const
      )
    )
  );
  await timeline.viewport.evaluate((viewport) => {
    let frames = 120;
    const reorder = () => {
      const first = viewport.firstElementChild;
      if (first) viewport.append(first);
      if (--frames > 0) requestAnimationFrame(reorder);
    };
    requestAnimationFrame(reorder);
  });
  for (let sample = 0; sample < 100; sample++) {
    const anchor = await timeline.anchorAt(1);
    expect(anchor.y, anchor.itemId).toBe(positions[anchor.itemId]);
  }
});

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

test('a bounded timeline window reaches old messages without losing the reader', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 900, height: 600 });
  await app.openRoom('!room:example.test');
  const values = historyItems({
    idPrefix: 'window',
    label: 'Window',
    count: 1_000,
    timestampBase: 1_699_999_000_000,
  });
  await core.emitTimelineDiff(await core.subscription(), [{ op: 'reset', values }]);
  await expect(timeline.itemById('window-999')).toBeInViewport();
  for (let page = 0; page < 30; page += 1) {
    const first = Number(await timeline.items.first().getAttribute('data-index'));
    if (first === 0) break;
    await timeline.scrollToAndNotify(0);
    const anchor = await timeline.fullyVisibleAnchor();
    await expect
      .poll(async () => Number(await timeline.items.first().getAttribute('data-index')))
      .toBeLessThan(first);
    await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
    expect(await timeline.items.count()).toBeLessThanOrEqual(120);
  }
  await expect(timeline.items.first()).toHaveAttribute('data-index', '0');
  await timeline.scrollToAndNotify(0);
  await expect(timeline.itemById('window-0')).toBeInViewport();
  await timeline.jumpToLatest.click();
  await expect(timeline.itemById('window-999')).toBeInViewport();
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  expect(await timeline.items.count()).toBeLessThanOrEqual(120);
});

test('continuous touch scrolling crosses window boundaries without offset writes', async ({
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
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'continuous',
        label: 'Continuous',
        count: 1000,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect(timeline.itemById('continuous-999')).toBeInViewport();
  await timeline.waitForScrollSettled();
  await timeline.viewport.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
  });
  const result = await timeline.viewport.evaluate(async (viewport) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (!descriptor?.get || !descriptor.set) throw new Error('missing scrollTop descriptor');
    const read = descriptor.get.bind(viewport);
    const write = descriptor.set.bind(viewport);
    let writes = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => Number(read.call(viewport)),
      set: (value: number) => {
        writes++;
        write.call(viewport, value);
      },
    });
    const first = Number(viewport.querySelector<HTMLElement>('.item')?.dataset.index);
    let clamped = false;
    let blank = false;
    let drift = 0;
    let maxRows = 0;
    const step = async (delta: number): Promise<void> => {
      const bounds = viewport.getBoundingClientRect();
      const anchor = Array.from(viewport.querySelectorAll('.item')).find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
      const content = anchor?.firstElementChild ?? anchor;
      const top = content?.getBoundingClientRect().top;
      const previous = viewport.scrollTop;
      write.call(viewport, previous + delta);
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      if (content && top !== undefined) {
        drift = Math.max(
          drift,
          content.isConnected
            ? Math.abs(content.getBoundingClientRect().top - top + delta)
            : Number.POSITIVE_INFINITY
        );
      }
      maxRows = Math.max(maxRows, viewport.querySelectorAll('.item').length);
      blank ||= !Array.from(viewport.querySelectorAll('.item')).some((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      clamped ||= Math.abs(viewport.scrollTop - previous - delta) > 1;
    };
    for (let frame = 0; frame < 160; frame++) await step(-120);
    const last = Number(viewport.querySelector<HTMLElement>('.item')?.dataset.index);
    for (let frame = 0; frame < 160; frame++) await step(120);
    return { first, last, writes, clamped, blank, drift, maxRows };
  });
  await timeline.viewport.dispatchEvent('touchend', { touches: [] });
  expect(result.clamped).toBe(false);
  expect(result.blank).toBe(false);
  expect(result.writes).toBe(0);
  expect(result.drift).toBeLessThanOrEqual(2);
  expect(result.maxRows).toBeLessThanOrEqual(120);
  expect(result.last).toBeLessThan(result.first - 80);
});

test('touch scrolling reaches latest after a distant jump and taller messages', async ({
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'resized',
        label: 'Resized',
        count: 1000,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect(timeline.itemById('resized-999')).toBeInViewport();
  await timeline.scrollToAndNotify(0);
  await expect(timeline.itemById('resized-0')).toBeInViewport();
  await timeline.waitForScrollSettled();
  await timeline.viewport.evaluate(instrumentSelfWrites);
  await timeline.viewport.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
  });
  const result = await timeline.viewport.evaluate(async (viewport) => {
    const style = document.createElement('style');
    style.textContent = '.item { min-height: 120px; }';
    document.head.append(style);
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (!descriptor?.set) throw new Error('missing native scrollTop setter');
    const write = descriptor.set.bind(viewport);
    let blank = false;
    let maxRows = 0;
    for (let frame = 0; frame < 400; frame++) {
      write(viewport.scrollTop + 400);
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      const bounds = viewport.getBoundingClientRect();
      const rows = Array.from(viewport.querySelectorAll('.item'));
      maxRows = Math.max(maxRows, rows.length);
      blank ||= !rows.some((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
    }
    return { blank, maxRows, writes: window.__e2eSelfWriteCount };
  });
  await timeline.viewport.dispatchEvent('touchend', { touches: [] });
  await expect(timeline.itemById('resized-999')).toBeInViewport();
  expect(result.blank).toBe(false);
  expect(result.writes).toBe(0);
  expect(result.maxRows).toBeLessThanOrEqual(120);
});

test('mobile native momentum crosses the original rendered window', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Native touch input is driven through CDP');
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'fling',
        label: 'Fling',
        count: 1000,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect(timeline.itemById('fling-999')).toBeInViewport();
  await timeline.waitForScrollSettled();
  const initialExtent = await timeline.viewport
    .locator('.window-rows')
    .evaluate((node) => node.getBoundingClientRect().height);
  const initialOffset = await timeline.scrollTop();
  const box = await timeline.viewport.boundingBox();
  if (!box) throw new Error('missing timeline bounds');
  await timeline.viewport.evaluate(instrumentSelfWrites);
  const client = await page.context().newCDPSession(page);
  await client.send('Input.synthesizeScrollGesture', {
    x: box.x + box.width / 2,
    y: box.y + box.height / 3,
    yDistance: initialExtent + box.height * 2,
    speed: 4000,
    preventFling: false,
    gestureSourceType: 'touch',
  });
  expect(initialOffset - (await timeline.scrollTop())).toBeGreaterThan(initialExtent);
  expect(await page.evaluate(() => window.__e2eSelfWriteCount)).toBe(0);
  await timeline.fullyVisibleAnchor();
  expect(await timeline.items.count()).toBeLessThanOrEqual(120);
  await client.detach();
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

  test('mobile native momentum control', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch input is driven through CDP');
    await page.setContent(PROBE_HTML);
    const viewport = page.locator('#probe');
    const client = await page.context().newCDPSession(page);
    const box = await viewport.boundingBox();
    if (!box) throw new Error('missing viewport');
    for (let drag = 0; drag < 4; drag += 1) {
      await viewport.evaluate((node) => {
        node.scrollTop = 1000;
      });
      const x = box.x + box.width / 2;
      const y = box.y + 60;
      await client.send('Input.synthesizeScrollGesture', {
        x,
        y,
        yDistance: 96,
        speed: 1000,
        preventFling: false,
        gestureSourceType: 'touch',
      });
      await page.waitForTimeout(500);
      expect(await viewport.evaluate((node) => node.scrollTop)).toBeLessThan(888);
    }
  });

  for (const momentum of [false, true]) {
    test(
      momentum
        ? 'a mobile flick stays stable while history loads during momentum'
        : 'a finger drag through unmeasured history moves the reader by exactly the drag',
      async ({ page, app, timeline, core, installRoomCore, browserName }) => {
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

        const STEP = momentum ? 16 : 24;
        const STEPS = momentum ? 6 : 12;
        const DRAGS = 8;
        const misses: object[] = [];
        let worstFrame = 0;
        for (let drag = 0; drag < DRAGS; drag += 1) {
          const sampling = await startGestureSample(timeline.viewport, {
            frames: 300,
            quietFrames: 12,
          });

          if (momentum) {
            await client.send('Input.synthesizeScrollGesture', {
              x,
              y: startY,
              yDistance: STEP * STEPS,
              speed: 1000,
              preventFling: false,
              gestureSourceType: 'touch',
            });
          } else {
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
          }

          const result = await sampling.finish();
          expect(result.unexpectedScrolls, 'smooth commands must not fight the finger').toEqual([]);
          worstFrame = Math.max(worstFrame, result.frameError);
          const missed = momentum
            ? result.readerMovement > -STEP * (STEPS + 1)
            : Math.abs(result.readerMovement + STEP * STEPS) > STEP;
          if ((!result.clamped && missed) || result.frameError > 2) {
            misses.push({ drag, pages: await core.paginateCount(), ...result });
          }
        }

        expect(misses, 'drags the reader did not receive in full').toEqual([]);
        expect(
          worstFrame,
          'a row moved on screen by more than the finger dragged'
        ).toBeLessThanOrEqual(2);
        expect(await core.paginateCount()).toBeGreaterThanOrEqual(2);
      }
    );
  }
});

test.describe('mobile', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'Requires a mobile browser profile');
  });

  test('iOS history updates never write scroll offsets during touch or momentum', async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
    browserName,
  }) => {
    test.skip(browserName !== 'webkit', 'iOS scroll-write contract');
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await loadScrollableHistory(core, timeline);
    await timeline.scrollAboveBottomAndNotify(200);
    await timeline.waitForScrollSettled();
    const anchor = await timeline.fullyVisibleAnchor();
    await timeline.viewport.evaluate(instrumentSelfWrites);
    const index = Number(await timeline.itemById(anchor.itemId).getAttribute('data-index'));
    await timeline.viewport.dispatchEvent('touchstart', {
      touches: [{ identifier: 1, clientX: 100, clientY: 300 }],
    });
    await core.emitTimelineDiff(await core.subscription(), [
      { op: 'push_front', value: timelineItem('ios-older', 'Older iOS history') },
    ]);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.__e2eSelfWriteCount)).toBe(0);
    await timeline.expectAnchorHeld(anchor, { tolerance: 2 });
    await timeline.viewport.dispatchEvent('touchend', { touches: [] });
    for (let frame = 0; frame < 5; frame += 1) {
      await timeline.viewport.evaluate((node) => {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        if (!descriptor?.set) throw new Error('missing native scrollTop setter');
        descriptor.set.call(node, node.scrollTop - 6);
      });
      await timeline.viewport.dispatchEvent('scroll');
      if (frame === 2) {
        await core.emitTimelineDiff(await core.subscription(), [
          { op: 'push_front', value: timelineItem('ios-older-again', 'More iOS history') },
        ]);
      }
      await page.waitForTimeout(60);
      expect(await page.evaluate(() => window.__e2eSelfWriteCount)).toBe(0);
    }
    await expect(timeline.itemById(anchor.itemId)).toHaveAttribute('data-index', String(index + 2));
    await timeline.expectAnchorHeld({ ...anchor, y: anchor.y + 30 }, { tolerance: 2 });
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
