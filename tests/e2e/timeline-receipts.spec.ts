import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineImage, timelineItem } from './fixtures/timeline-items';

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

test('receipts beside text, reactions, an embed or an image add no row of their own', async ({
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
  const text = timelineItem('general-18', 'see https://example.test/page');
  const trailing = {
    text,
    reactions: { ...text, reactions: [{ key: '👍', senders: ['@bob:example.test'] }] },
    embed: {
      ...text,
      bundled_link_previews: [
        {
          url: 'https://example.test/page',
          title: 'Example page',
          description: 'A description of the page',
          site_name: 'Example',
          image: null,
          image_mime: null,
          image_width: null,
          image_height: null,
        },
      ],
    },
    image: timelineImage('general-18'),
  };
  const row = page.locator('[data-item-id="general-18"] .message');

  for (const [name, item] of Object.entries(trailing)) {
    const measure = async (readBy: string[]) => {
      await core.setTimelineItemById(subscription, 'general-18', { ...item, read_by: readBy });
      await expect(row.locator('.receipt-slot')).toHaveCount(readBy.length);
      return row.evaluate((node) => ({
        height: Math.round(node.getBoundingClientRect().height),
        beside: node.querySelector('.message-content')?.classList.contains('receipt-beside'),
      }));
    };
    const plain = await measure([]);
    const receipted = await measure(['@bob:example.test']);
    expect(Math.abs(receipted.height - plain.height), name).toBeLessThanOrEqual(1);
    if (item !== text) expect(receipted.beside, name).toBe(true);
  }
});

test('bubble receipts sit beside trailing reactions on either side', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ layout: 'bubble' }));
  });
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  const subscription = await core.subscription();
  const row = page.locator('[data-item-id="general-18"] .message');
  const reacted = {
    ...timelineItem('general-18', 'hello there'),
    reactions: [{ key: '👍', senders: ['@bob:example.test'] }],
  };

  for (const own of [false, true]) {
    const measure = async (readBy: string[]) => {
      await core.setTimelineItemById(subscription, 'general-18', {
        ...reacted,
        is_own: own,
        read_by: readBy,
      });
      await expect(row.locator('.receipt-slot')).toHaveCount(readBy.length);
      return row.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    };
    const plain = await measure([]);
    expect(await measure(['@bob:example.test']), String(own)).toBe(plain);
    await expect(row.locator('.message-content')).toHaveClass(/receipt-beside/);
  }
});
