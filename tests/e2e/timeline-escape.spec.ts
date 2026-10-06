import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

test('Escape jumps to the latest message while the composer is focused', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: historyItems({
        idPrefix: 'escape',
        label: 'Escape history',
        count: 300,
        timestampBase: 1_699_999_000_000,
      }),
    },
  ]);
  await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
  await timeline.wheelUp(1500);
  await timeline.waitForScrollSettled();
  expect(await timeline.distanceFromBottom()).toBeGreaterThan(300);

  await app.composer.focus();
  await page.keyboard.press('Escape');

  await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
});
