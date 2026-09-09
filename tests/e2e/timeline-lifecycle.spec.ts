import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT, hasTouch: true });

test('backgrounding an interrupted touch settles queued history without moving the reader', async ({
  app,
  timeline,
  core,
  installRoomCore,
  page,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'lifecycle',
        label: 'Lifecycle history',
        count: 1_000,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect(timeline.itemById('lifecycle-999')).toBeInViewport();
  await timeline.scrollAboveBottomAndNotify(2_000);
  await timeline.waitForScrollSettled();
  const anchor = await timeline.fullyVisibleAnchor({ skip: 1 });
  const indexAttribute = await timeline.itemById(anchor.itemId).getAttribute('data-index');
  if (indexAttribute === null) throw new Error(`missing data-index for ${anchor.itemId}`);
  const index = Number(indexAttribute);

  await timeline.viewport.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
  });
  await core.emitTimelineDiff(subscription, [
    {
      op: 'insert',
      index: Math.max(0, index - 5),
      value: timelineItem('lifecycle-queued', 'Queued while backgrounded'),
    },
  ]);
  await expect(timeline.itemById('lifecycle-queued')).toHaveCount(0);

  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    if (original) Object.defineProperty(document, 'visibilityState', original);
    else delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  });

  await expect(timeline.itemById('lifecycle-queued')).toHaveCount(1);
  await timeline.expectAnchorHeld(anchor, { tolerance: 1 });
});
