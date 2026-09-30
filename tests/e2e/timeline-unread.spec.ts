import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: 420 });
});

const room = '!room:example.test';
const notified = `/to/${encodeURIComponent(room)}?notified=${encodeURIComponent('$general-15:example.test')}`;

test('the reveal starts at unread on room entry', async ({
  app,
  timeline,
  page,
  installRoomCore,
}) => {
  await installRoomCore('unread');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  await expect(timeline.message('General message 19')).not.toBeInViewport();
  await expect(page.getByRole('button', { name: 'Jump to unread' })).toHaveCount(0);
});

test('the reveal from notifications preserves unread until jumping', async ({
  page,
  timeline,
  core,
  installRoomCore,
}, testInfo) => {
  await installRoomCore('unread');
  await page.goto(notified);
  await timeline.expectRevealed();
  const jump = page.getByRole('button', { name: 'Jump to unread' });
  await expect(jump).toBeVisible();
  await expect(jump).toContainText('15 new messages');
  await expect(timeline.message('General message 15')).toBeInViewport();
  await expect(timeline.message('General message 5')).not.toBeInViewport();
  // Wait past the receipt coalescing window so an accidental read cannot pass.
  await page.waitForTimeout(650);
  expect((await core.commands()).filter((command) => command === 'mark_read')).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('unread-bar.png') });
  await jump.click();
  await expect(timeline.message('General message 5')).toBeInViewport();
  await expect(jump).toHaveCount(0);
  await expect.poll(() => core.commands()).toContain('mark_read');
});

test('the reveal offers mark as read', async ({ page, timeline, core, installRoomCore }) => {
  await installRoomCore('unread');
  await page.goto(notified);
  await timeline.expectRevealed();
  await page.locator('.unread-bar').getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.locator('.unread-bar')).toHaveCount(0);
  await expect(timeline.message('General message 15')).toBeInViewport();
  await expect.poll(() => core.commands()).toContain('mark_read');
});

test('the reveal loads the unread boundary from history', async ({
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_history');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  await expect(timeline.message('General message 19')).not.toBeInViewport();
  expect(await core.paginateCount()).toBeGreaterThan(0);
});
