import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

test('a held touch keeps a shrunken bounded latest window at the composer', async ({
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'gap',
        label: 'Gap',
        count: 1_000,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect(timeline.itemById('gap-999')).toBeInViewport();
  await timeline.viewport.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
  });
  await timeline.viewport.evaluate((viewport) => {
    const style = document.createElement('style');
    style.textContent = `
      .timeline-viewport .item {
        box-sizing: border-box !important;
        height: 25px !important;
        min-height: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
        padding: 0 !important;
      }
    `;
    viewport.ownerDocument.head.append(style);
  });
  await expect
    .poll(() => timeline.items.first().evaluate((item) => item.getBoundingClientRect().height))
    .toBeLessThanOrEqual(25);
  await expect
    .poll(() =>
      timeline.viewport.evaluate((viewport) => {
        const last = viewport.querySelector<HTMLElement>('.item:last-child');
        if (!last) throw new Error('missing latest row');
        return Math.abs(
          last.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom
        );
      })
    )
    .toBeLessThanOrEqual(1);
  const layoutGap = await timeline.viewport.evaluate((viewport) => {
    const last = viewport.querySelector<HTMLElement>('.item:last-child');
    const footer = viewport.closest('.timeline-content')?.querySelector('.timeline-foot');
    const dock = document.querySelector<HTMLElement>('.composer-dock');
    if (!last || !footer || !dock) throw new Error('timeline layout boundary missing');
    const lastBottom = last.getBoundingClientRect().bottom;
    const footerRect = footer.getBoundingClientRect();
    const dockTop = dock.getBoundingClientRect().top;
    return {
      footerHeight: footerRect.height,
      gap: dockTop - lastBottom,
      footerToDock: dockTop - footerRect.bottom,
    };
  });
  expect(Math.abs(layoutGap.gap - layoutGap.footerHeight)).toBeLessThanOrEqual(1);
  expect(layoutGap.footerToDock).toBeLessThanOrEqual(1);
  await timeline.viewport.dispatchEvent('touchend', { touches: [] });
  await core.emitTimelineDiff(subscription, [
    { op: 'push_back', value: timelineItem('gap-echo', 'Sent after shrink') },
  ]);
  await expect(timeline.itemById('gap-echo')).toBeInViewport();
});
