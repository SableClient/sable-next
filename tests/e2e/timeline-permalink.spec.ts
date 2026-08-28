// Scripted transport: the jump only restarts the timeline when the target is
// outside the loaded range, and a real homeserver cannot withhold events.

import { expect, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

const DISTANT_EVENT = '$distant:example.test';

test('jumps to an event outside the loaded range', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openHome();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await expect.poll(() => core.subscribeCount()).toBe(1);

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...timelineItem('reply-to-distant', 'Answering something older'),
        in_reply_to: {
          event_id: DISTANT_EVENT,
          sender: '@bob:example.test',
          sender_name: 'Bob',
          body: 'The distant message',
        },
      },
    },
  ]);

  const reply = timeline.itemById('reply-to-distant').locator('.reply-preview');
  await expect(reply).toBeVisible();
  await reply.click();

  await expect.poll(() => new URL(page.url()).searchParams.get('event')).toBe(DISTANT_EVENT);
  await expect.poll(() => core.subscribeCount()).toBe(2);
});
