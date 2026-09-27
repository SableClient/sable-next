import type { Locator, Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

function menu(page: Page) {
  return page.locator('.message-menu');
}

test.beforeEach(async ({ app, core, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: [
        timelineItem('menu-1', 'First message'),
        timelineItem('menu-2', 'Second message'),
        timelineItem('menu-3', 'Third message'),
      ],
    },
  ]);
});

async function rightClick(page: Page, row: Locator, end: 'start' | 'end') {
  const box = await row.boundingBox();
  if (!box) throw new Error('the message row has no box');
  const x = end === 'start' ? box.x + 20 : box.x + box.width - 20;
  await page.mouse.click(x, box.y + box.height / 2, { button: 'right' });
}

test('right-clicking a second message moves the menu to it', async ({ page, timeline }) => {
  await rightClick(page, timeline.itemById('menu-1').locator('article.message'), 'start');
  await expect(menu(page)).toHaveCount(1);
  const first = await menu(page).boundingBox();

  await rightClick(page, timeline.itemById('menu-3').locator('article.message'), 'end');

  await expect(menu(page)).toHaveCount(1);
  const second = await menu(page).boundingBox();
  expect(second?.x).toBeGreaterThan((first?.x ?? 0) + 100);
});

test('right-clicking the same message again reopens the menu at the pointer', async ({
  page,
  timeline,
}) => {
  const row = timeline.itemById('menu-2').locator('article.message');
  await rightClick(page, row, 'start');
  await expect(menu(page)).toHaveCount(1);
  const first = await menu(page).boundingBox();

  await rightClick(page, row, 'end');

  await expect(menu(page)).toHaveCount(1);
  const second = await menu(page).boundingBox();
  expect(second?.x).toBeGreaterThan((first?.x ?? 0) + 100);
});
