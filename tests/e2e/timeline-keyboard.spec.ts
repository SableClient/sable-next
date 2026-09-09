import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';

test.use({
  storageState: SIGNED_OUT,
  hasTouch: true,
  viewport: { width: 390, height: 300 },
});

test('keyboard viewport shrink keeps the latest row at the bottom during an active touch', async ({
  page,
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
        idPrefix: 'keyboard',
        label: 'Keyboard history',
        count: 1_000,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect(timeline.itemById('keyboard-999')).toBeInViewport();
  await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);

  await timeline.viewport.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
  });
  await app.composer.focus();
  const heightBefore = await timeline.viewport.evaluate((viewport) => viewport.clientHeight);
  await page.setViewportSize({ width: 390, height: 200 });
  // Wait for the resize notification before sampling the stabilized layout.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const frames = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>('.timeline-viewport .viewport');
    const latest = document.querySelector<HTMLElement>('[data-item-id="keyboard-999"]');
    const composer = document.querySelector<HTMLElement>('.composer-dock');
    if (!viewport || !latest || !composer)
      throw new Error('missing timeline viewport, latest row, or composer');
    const frames: { height: number; gap: number }[] = [];
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise(requestAnimationFrame);
      const visibleBottom = Math.min(
        viewport.getBoundingClientRect().bottom,
        composer.getBoundingClientRect().top
      );
      frames.push({
        height: viewport.clientHeight,
        gap: visibleBottom - latest.getBoundingClientRect().bottom,
      });
    }
    return frames;
  });

  expect(frames.some((frame) => frame.height < heightBefore)).toBe(true);
  expect(
    Math.max(...frames.map((frame) => Math.abs(frame.gap))),
    `keyboard frames: ${JSON.stringify(frames)}`
  ).toBeLessThanOrEqual(1);
  await expect(timeline.itemById('keyboard-999')).toBeInViewport();
  await timeline.viewport.dispatchEvent('touchend', { touches: [] });
  await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
  await core.emitTimelineDiff(await core.subscription(), [
    { op: 'push_back', value: timelineItem('keyboard-echo', 'Keyboard echo') },
  ]);
  await expect(timeline.itemById('keyboard-echo')).toBeInViewport();
  await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      timeline.viewport.evaluate((viewport) => {
        const latest = viewport.querySelector<HTMLElement>('[data-item-id="keyboard-echo"]');
        const composer = document.querySelector<HTMLElement>('.composer-dock');
        if (!latest || !composer) throw new Error('missing latest row or composer');
        return Math.abs(
          Math.min(viewport.getBoundingClientRect().bottom, composer.getBoundingClientRect().top) -
            latest.getBoundingClientRect().bottom
        );
      })
    )
    .toBeLessThanOrEqual(1);
});
