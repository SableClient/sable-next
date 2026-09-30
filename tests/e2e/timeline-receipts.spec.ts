import type { Locator } from '@playwright/test';

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

async function heightSettled(row: Locator): Promise<void> {
  let settled = Number.NaN;
  await expect
    .poll(
      async () => {
        const height = await row.evaluate((node) => node.getBoundingClientRect().height);
        const same = height === settled;
        settled = height;
        return same;
      },
      { intervals: [250] }
    )
    .toBe(true);
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

test('a receipt never takes a line of its own or covers text when the last line is full', async ({
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
  const row = page.locator('[data-item-id="general-18"] .message');

  for (const unit of ['word ', 'adsf']) {
    for (let length = 60; length <= 140; length += 1) {
      const body = unit.repeat(40).slice(0, length).trim();
      await core.setTimelineItemById(subscription, 'general-18', {
        ...timelineItem('general-18', body),
        read_by: ['@bob:example.test'],
      });
      await expect(row.locator('.formatted-body')).toHaveText(body);
      await expect(row.locator('.receipt-slot')).toHaveCount(1);
      await heightSettled(row);
      const box = await row.evaluate((node) => {
        const text = node.querySelector('.formatted-body');
        const badge = node.querySelector('.read-receipt-stack');
        if (!text || !badge) throw new Error('missing body or badge');
        const range = document.createRange();
        range.selectNodeContents(text);
        const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
        const badgeBox = badge.getBoundingClientRect();
        const last = lines.at(-1);
        return {
          below: last ? badgeBox.top - last.bottom : Number.POSITIVE_INFINITY,
          overlap: lines.some(
            (rect) =>
              rect.right > badgeBox.left + 0.5 &&
              rect.left < badgeBox.right - 0.5 &&
              rect.bottom > badgeBox.top + 0.5 &&
              rect.top < badgeBox.bottom - 0.5
          ),
        };
      });
      const label = `${unit.trim()} × ${String(length)}`;
      expect(box.below, label).toBeLessThan(0);
      expect(box.overlap, label).toBe(false);
    }
  }
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
      await heightSettled(row);
      return row.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    };
    const plain = await measure([]);
    const receipted = await measure(['@bob:example.test']);
    expect(Math.abs(receipted - plain), name).toBeLessThanOrEqual(1);
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
      await heightSettled(row);
      return row.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    };
    const plain = await measure([]);
    expect(await measure(['@bob:example.test']), String(own)).toBe(plain);
  }
});
