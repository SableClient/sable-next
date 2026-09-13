import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

test.describe('touch', () => {
  test.use({ hasTouch: true, viewport: { width: 412, height: 915 } });

  test('mobile: the message sheet hands the reaction sheet its back entry', async ({
    app,
    page,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    const subscription = await core.subscription();
    await core.emitTimelineDiff(subscription, [
      { op: 'reset', values: [timelineItem('react-1', 'Press me')] },
    ]);

    const row = timeline.itemById('react-1').locator('article.message');
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    if (!box) throw new Error('the message row has no box');
    await row.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box.x + 10,
      clientY: box.y + 10,
    });

    const actions = page.getByRole('dialog', { name: 'More actions' });
    await expect(actions).toBeVisible();
    await actions.getByRole('button', { name: 'Add reaction' }).click();

    const reactions = page.getByRole('dialog', { name: 'Add reaction' });
    await expect(reactions).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(reactions).toBeVisible();

    await page.goBack();
    await expect(reactions).toBeHidden();
    await expect(row).toBeVisible();
  });
});

test('the context menu opens the reaction board as a popover, not a sheet', async ({
  app,
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    { op: 'reset', values: [timelineItem('react-2', 'Right click me')] },
  ]);

  const row = timeline.itemById('react-2').locator('article.message');
  await expect(row).toBeVisible();
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error('the message row has no box');
  const offset = { x: rowBox.width / 2, y: rowBox.height - 4 };
  const point = { x: rowBox.x + offset.x, y: rowBox.y + offset.y };
  await row.click({ button: 'right', position: offset });

  await page.getByRole('menuitem', { name: 'Add reaction' }).click();

  const picker = page.locator('.reaction-picker');
  await expect(picker).toBeVisible();
  await expect(page.locator('.dialog-content-sheet')).toHaveCount(0);

  const board = await picker.boundingBox();
  if (!board) throw new Error('the reaction popover has no box');
  expect(Math.abs(board.x + board.width - point.x)).toBeLessThan(48);
  expect(Math.abs(board.y + board.height - point.y)).toBeLessThan(48);
});
