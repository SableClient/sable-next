import { expect, SIGNED_OUT, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

test('mobile: a message that fills its line without wrapping keeps a one-line row', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  const subscription = await core.subscription();

  const measure = async (body: string) => {
    await core.setTimelineItemById(subscription, 'general-18', timelineItem('general-18', body));
    await expect(page.locator('[data-item-id="general-18"] .formatted-body')).toHaveText(body);
    return page.evaluate(() => {
      const row = document.querySelector('[data-item-id="general-18"] .message');
      const text = row?.querySelector('.formatted-body');
      if (!row || !text) throw new Error('missing row');
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      return { lines, height: Math.round(row.getBoundingClientRect().height) };
    });
  };

  const oneLine = (await measure('word')).height;
  for (let length = 20; length <= 70; length += 1) {
    const { lines, height } = await measure('word '.repeat(20).slice(0, length).trim());
    if (lines === 1) expect(height, `a ${String(length)}-character message`).toBe(oneLine);
  }
});
