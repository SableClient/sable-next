import { expect, test, SIGNED_OUT } from './fixtures/test';
import { quietFor, RECEIPT_COALESCE_MS } from './fixtures/settle';
import { timelineItem } from './fixtures/timeline-items';

declare global {
  interface Window {
    __e2eWindowFocused: boolean;
  }
}

test.use({ storageState: SIGNED_OUT });

test('a mention that arrived in the background is seen once the window is focused again', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    window.__e2eWindowFocused = true;
    document.hasFocus = () => window.__e2eWindowFocused;
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  const control = page.getByRole('button', { name: /^Next unread mention/ });
  await expect(control).toBeHidden();

  await page.evaluate(() => {
    window.__e2eWindowFocused = false;
    window.dispatchEvent(new Event('blur'));
  });
  await core.emitTimelineDiff(await core.subscription(), [
    { op: 'push_back', value: { ...timelineItem('pinged', 'A ping for you'), mention: 'loud' } },
  ]);
  await page.evaluate(() => {
    window.__e2eMentionEventIds = ['$pinged:example.test'];
    window.__e2eEmitTimelineEvent({ type: 'inbox_changed' });
  });
  await expect(timeline.message('A ping for you')).toBeInViewport();
  await expect(control).toBeVisible();

  await page.evaluate(() => {
    window.__e2eWindowFocused = true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(control).toBeHidden();
});

test('a mention listed only after the window is focused again is seen too', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    window.__e2eWindowFocused = true;
    document.hasFocus = () => window.__e2eWindowFocused;
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  const control = page.getByRole('button', { name: /^Next unread mention/ });
  await expect(control).toBeHidden();

  await page.evaluate(() => {
    window.__e2eWindowFocused = false;
    window.dispatchEvent(new Event('blur'));
  });
  await core.emitTimelineDiff(await core.subscription(), [
    { op: 'push_back', value: { ...timelineItem('pinged', 'A ping for you'), mention: 'loud' } },
  ]);
  await expect(timeline.message('A ping for you')).toBeInViewport();
  await page.evaluate(() => {
    window.__e2eWindowFocused = true;
    window.dispatchEvent(new Event('focus'));
  });
  await timeline.waitForScrollSettled();

  const listed = await page.evaluate(
    () => window.__e2eCalls.filter((call) => call.method === 'notifications.inbox').length
  );
  await page.evaluate(() => {
    window.__e2eMentionEventIds = ['$pinged:example.test'];
    window.__e2eEmitTimelineEvent({ type: 'inbox_changed' });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__e2eCalls.filter((call) => call.method === 'notifications.inbox').length
      )
    )
    .toBeGreaterThan(listed);
  // Long enough for the answer to reach the room, so a control that shows late is caught.
  await quietFor(page, RECEIPT_COALESCE_MS);
  await expect(control).toBeHidden();
});
