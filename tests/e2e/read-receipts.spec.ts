import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

for (const placement of ['message', 'room'] as const) {
  for (const width of [1280, 390]) {
    test(`receipt timestamps in ${placement} tooltips and popups at ${String(width)}px`, async ({
      page,
      app,
      timeline,
      core,
      installRoomCore,
    }, testInfo) => {
      await installRoomCore('ready');
      await page.addInitScript(
        (preferences) => {
          localStorage.setItem('sable-preferences', JSON.stringify(preferences));
        },
        { readReceiptPlacement: placement, theme: width < 500 ? 'dark' : 'light' }
      );
      await page.setViewportSize({ width, height: 800 });
      await app.openRoom('!room:example.test');
      await timeline.expectAtLatest('General message 19');
      const subscription = await core.subscription(0);
      const timestamp = 1_700_000_000_000;
      const item = {
        ...timelineItem('receipt-time', 'A message with a read receipt'),
        read_by: ['@bob:example.test', '@carol:example.test', '@d:example.test', '@e:example.test'],
        read_timestamps: { '@bob:example.test': timestamp },
      };
      await core.emitTimelineDiff(subscription, [{ op: 'push_back', value: item }]);
      const stack = page.locator(
        placement === 'message'
          ? '[data-item-id="receipt-time"] .read-receipt-stack'
          : '.room-read-receipts .read-receipt-stack'
      );
      await expect(stack).toBeVisible();
      await stack.locator('button.face').first().hover();
      const tooltip = page.locator('[data-tooltip-content]');
      await expect(tooltip.locator('time')).toHaveAttribute(
        'datetime',
        new Date(timestamp).toISOString()
      );
      await page.screenshot({ path: testInfo.outputPath('receipt-tooltip.png') });
      await stack.locator('button.overflow').click();
      const popup = page.locator('.member-user-list');
      await expect(popup.locator('time')).toHaveCount(1);
      await expect(popup.locator('time')).toHaveAttribute(
        'datetime',
        new Date(timestamp).toISOString()
      );
      await page.screenshot({ path: testInfo.outputPath('receipt-popup.png') });
      await core.setTimelineItemById(subscription, item.id, {
        ...item,
        read_timestamps: { '@bob:example.test': timestamp + 60_000 },
      });
      await expect(popup.locator('time')).toHaveAttribute(
        'datetime',
        new Date(timestamp + 60_000).toISOString()
      );
    });
  }
}
