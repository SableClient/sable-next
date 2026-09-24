import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

function reacted(id: string, own: boolean) {
  return {
    ...timelineItem(id, own ? 'mine' : 'theirs'),
    is_own: own,
    sender: own ? '@me:example.test' : '@alice:example.test',
    read_by: ['@bob:example.test', '@carol:example.test'],
    reactions: [{ key: '👍', senders: ['@bob:example.test'] }],
  };
}

test('own bubble receipts reach the same edge as everyone else’s on mobile', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ layout: 'bubble' }));
  });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  const subscription = await core.subscription();
  await core.setTimelineItemById(subscription, 'general-19', reacted('general-19', true));
  await core.setTimelineItemById(subscription, 'general-18', reacted('general-18', false));
  await expect(page.locator('.message-content > .receipt-slot')).toHaveCount(2);

  const edges = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.message-content > .receipt-slot')].map((node) => [
        node.closest('.message')?.classList.contains('own') ? 'own' : 'other',
        Math.round(node.getBoundingClientRect().right),
      ])
    )
  );
  expect(edges.own).toBe(edges.other);
});
