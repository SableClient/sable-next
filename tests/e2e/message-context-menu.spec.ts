import type { Locator, Page } from '@playwright/test';
import en from '../../src/locales/en.json' with { type: 'json' };

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';
import { nextFrames } from './fixtures/settle';

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

test('a hover action still fires when the row loses hover and focus mid-press', async ({
  page,
  timeline,
}) => {
  const row = timeline.itemById('menu-2').locator('article.message');
  await row.hover();
  const reply = row.locator('.message-actions').getByRole('button', {
    name: en.timeline.reply,
    exact: true,
  });
  await reply.hover();
  await page.mouse.down();
  await reply.dispatchEvent('focusout', { relatedTarget: null });
  await row.dispatchEvent('pointerleave', { pointerType: 'mouse', buttons: 1 });
  await page.mouse.up();

  await expect(
    page.getByText(en.composer.replyingTo.replace('{{name}}', '')).first()
  ).toBeVisible();
});

test.describe('mobile reactions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('dismissing reaction details leaves no message menu open', async ({
    page,
    timeline,
    core,
  }) => {
    const item = {
      ...timelineItem('reaction-menu', 'Message with reactions'),
      reactions: [{ key: '👍', senders: ['@alice:example.test'] }],
    };
    await core.emitTimelineDiff(await core.subscription(), [{ op: 'reset', values: [item] }]);
    const row = timeline.itemById(item.id);
    const reaction = row.locator('button.reaction');
    const details = page.getByRole('dialog', { name: 'View reactions', exact: true });
    const actions = page.getByRole('dialog', { name: 'More actions', exact: true });

    await reaction.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
    await expect(details).toBeVisible();
    await reaction.dispatchEvent('contextmenu', { pointerType: 'touch' });
    await reaction.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
    await expect(actions).toHaveCount(0);

    const backdrop = page.locator('.dialog-backdrop');
    await backdrop.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      clientX: 195,
      clientY: 200,
    });
    await nextFrames(page, 3);
    await backdrop.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
    await backdrop.dispatchEvent('click', { clientX: 195, clientY: 200 });
    await expect(details).toHaveCount(0);
    await expect(actions).toHaveCount(0);
    await expect(menu(page)).toHaveCount(0);
    expect(await core.commands()).not.toContain('react');

    await reaction.tap();
    await expect.poll(() => core.commands()).toContain('react');

    const body = row.locator('article.message');
    await body.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
    await expect(actions).toBeVisible();
    await body.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
    await expect(details).toHaveCount(0);
  });
});
