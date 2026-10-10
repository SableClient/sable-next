import { expect, test, SIGNED_OUT } from './fixtures/test';
import { quietFor, RECEIPT_COALESCE_MS } from './fixtures/settle';

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
  await quietFor(page, RECEIPT_COALESCE_MS);
  expect((await core.commands()).filter((command) => command === 'mark_read')).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('unread-bar.png') });
  await jump.click();
  await expect(timeline.message('General message 5')).toBeInViewport();
  await expect(jump).toHaveCount(0);
  await expect.poll(() => core.commands()).toContain('mark_read');
});

test('the reveal from notifications sends a receipt once the reader reaches the latest message', async ({
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread');
  await page.goto(notified);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).not.toBeInViewport();
  await quietFor(page, RECEIPT_COALESCE_MS);
  expect((await core.commands()).filter((command) => command === 'mark_read')).toHaveLength(0);
  await timeline.scrollToBottomAndNotify();
  await expect(timeline.message('General message 19')).toBeInViewport();
  await expect(timeline.message('General message 5')).not.toBeInViewport();
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

test('the reveal loads a large unread backlog from marker context without scanning history', async ({
  app,
  timeline,
  core,
  page,
  installRoomCore,
}) => {
  await installRoomCore('unread_history');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  await expect(timeline.message('General message 19')).not.toBeInViewport();
  const backward = (await page.evaluate(() => window.__e2ePaginationDirections)).filter(
    (direction) => direction === 'backward'
  );
  expect(backward.length).toBeLessThanOrEqual(1);
  expect(await core.subscribeCount()).toBe(2);
});

test('the reveal stays readable when marker context fails', async ({
  app,
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_context_error');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 9999')).toBeInViewport();
  const backward = (await page.evaluate(() => window.__e2ePaginationDirections)).filter(
    (direction) => direction === 'backward'
  );
  expect(backward.length).toBeLessThanOrEqual(1);
  await expect.poll(() => core.commands()).toContain('mark_read');
  await expect(timeline.message('General message 9999')).toBeInViewport();
});

test('the reveal can read forwards from unread and jump to the live room', async ({
  app,
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_history');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  const subscriptions = await core.subscribeCount();
  await expect
    .poll(async () => {
      await timeline.wheelDown(2_000);
      return timeline.message('General message 20').count();
    })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(timeline.message('General message 9999')).toBeInViewport();
  expect(await core.subscribeCount()).toBe(subscriptions + 1);
});

test('the reveal keeps unread context when the room summary changes', async ({
  app,
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_history');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  const subscriptions = await core.subscribeCount();
  const reader = await timeline.fullyVisibleAnchor();
  await page.evaluate(() => {
    window.__e2eRefreshRoom();
  });
  await quietFor(page, RECEIPT_COALESCE_MS);
  expect(await core.subscribeCount()).toBe(subscriptions);
  await timeline.expectAnchorHeld(reader);
});

test('the reveal resumes live at forward end without moving the reader or losing arrivals', async ({
  app,
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_catchup');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  const subscriptions = await core.subscribeCount();
  for (const body of ['General message 40', 'General message 60']) {
    await expect
      .poll(async () => {
        await timeline.wheelDown(2_000);
        return timeline.message(body).count();
      })
      .toBeGreaterThan(0);
  }
  await timeline.waitForScrollSettled();
  const reader = await timeline.fullyVisibleAnchor();
  await expect.poll(() => core.subscribeCount()).toBe(subscriptions + 1);
  await expect(timeline.message('Arrived during handoff')).toBeAttached();
  await timeline.expectAnchorHeld(reader);
  await page.evaluate(() => {
    window.__e2eReceiveMessage('New live message');
  });
  await expect(timeline.message('New live message')).toBeAttached();
});

test('a notification context stays put at forward end until the reader jumps to latest', async ({
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_catchup');
  await page.goto(
    `/to/${encodeURIComponent(room)}?notified=${encodeURIComponent('$general-12:example.test')}`
  );
  await timeline.expectRevealed();
  await expect(page.locator('.message.highlighted')).toContainText('General message 12');
  const subscriptions = await core.subscribeCount();
  await expect
    .poll(async () => {
      await timeline.wheelDown(2_000);
      return timeline.message('General message 79').count();
    })
    .toBeGreaterThan(0);
  await quietFor(page, RECEIPT_COALESCE_MS);
  expect(await core.subscribeCount()).toBe(subscriptions);

  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect.poll(() => core.subscribeCount()).toBe(subscriptions + 1);
  await expect(timeline.message('Arrived during handoff')).toBeInViewport();
});

test('the reveal keeps the row the reader scrolled to during the live handoff', async ({
  app,
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_catchup');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  const subscriptions = await core.subscribeCount();
  for (const body of ['General message 40', 'General message 60']) {
    await expect
      .poll(async () => {
        await timeline.wheelDown(2_000);
        return timeline.message(body).count();
      })
      .toBeGreaterThan(0);
  }
  await expect.poll(() => core.subscribeCount()).toBe(subscriptions + 1);
  await timeline.wheelUp(600);
  await timeline.waitForScrollSettled();
  const reader = await timeline.fullyVisibleAnchor();
  await expect(timeline.message('Arrived during handoff')).toBeAttached();
  await timeline.expectAnchorHeld(reader);
  expect(await page.evaluate(() => window.__e2ePaginationDirections)).toContain('backward');
});

test('the reveal switches to live before sending from unread context', async ({
  app,
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_catchup');
  await app.openRoom(room);
  await timeline.expectRevealed();
  await expect(timeline.message('General message 5')).toBeInViewport();
  const composer = page.locator('[contenteditable="true"]');
  await composer.fill('Sent from unread context');
  await composer.press('Enter');
  await expect(timeline.message('Sent from unread context')).toBeInViewport();
  const commands = await core.commands();
  expect(commands.lastIndexOf('subscribe_timeline')).toBeLessThan(commands.indexOf('send_message'));
});

test('a notification for an unloaded event opens its context without marking the room read', async ({
  page,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('unread_history');
  await page.goto(
    `/to/${encodeURIComponent(room)}?notified=${encodeURIComponent('$general-12:example.test')}`
  );
  await timeline.expectRevealed();
  await expect(page.locator('.message.highlighted')).toContainText('General message 12');
  await expect(timeline.message('General message 12')).toBeInViewport();
  expect(new URL(page.url()).searchParams.has('event')).toBe(false);
  await quietFor(page, RECEIPT_COALESCE_MS);
  expect((await core.commands()).filter((command) => command === 'mark_read')).toHaveLength(0);
});

test('the reveal jumps from an unloaded notification marker without adding a permalink', async ({
  page,
  timeline,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    document.hasFocus = () => false;
  });
  await installRoomCore('unread_history');
  await page.goto(
    `/to/${encodeURIComponent(room)}?notified=${encodeURIComponent('$general-9999:example.test')}`
  );
  await timeline.expectRevealed();
  await page.getByRole('button', { name: 'Jump to unread' }).click();
  await expect(timeline.message('General message 5')).toBeInViewport();
  expect(new URL(page.url()).searchParams.has('event')).toBe(false);
});
