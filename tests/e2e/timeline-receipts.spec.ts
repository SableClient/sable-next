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

for (const layout of ['modern', 'compact', 'bubble'] as const) {
  test(`mobile: ${layout} receipts do not overlap wrapped reactions`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await page.addInitScript((layout) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ layout }));
    }, layout);
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await timeline.expectRevealed();
    const subscription = await core.subscription();
    const row = page.locator('[data-item-id="general-18"] .message');
    const readers = Array.from(
      { length: 38 },
      (_, index) => `@reader${String(index)}:example.test`
    );
    const reactions = [
      "I'm updating my server",
      "/query nex I'm updating",
      '😂',
      'what.',
      '🐟',
      '🤨',
      '😭',
      '👍',
      'PDU in invite state (index 1) violates the room event format',
    ].map((key) => ({ key, senders: readers.slice(0, 14) }));

    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const own of [false, true]) {
        for (const count of [1, 38]) {
          const label = `${String(width)}px, own=${String(own)}, readers=${String(count)}`;
          await core.setTimelineItemById(subscription, 'general-18', {
            ...timelineItem('general-18', 'Hello everyone'),
            is_own: own,
            reactions,
            read_by: readers.slice(0, count),
          });
          await expect(row.locator('.read-receipt-stack')).toBeVisible();
          await heightSettled(row);
          const overlap = await row.evaluate((node) => {
            const receipt = node.querySelector('.read-receipt-stack');
            if (!receipt) throw new Error('missing receipt');
            const badge = receipt.getBoundingClientRect();
            return [...node.querySelectorAll('.reaction, .add-reaction')].some((reaction) => {
              const box = reaction.getBoundingClientRect();
              return (
                box.left < badge.right - 0.5 &&
                box.right > badge.left + 0.5 &&
                box.top < badge.bottom - 0.5 &&
                box.bottom > badge.top + 0.5
              );
            });
          });
          expect(overlap, label).toBe(false);
        }
      }
    }
  });
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

for (const device of ['desktop', 'mobile']) {
  test.describe(`read receipts on ${device}`, () => {
    test.use({
      viewport: device === 'mobile' ? { width: 412, height: 839 } : { width: 1280, height: 800 },
    });
    test('transparent avatars cover the preceding avatar', async ({
      page,
      app,
      core,
      timeline,
      installRoomCore,
    }) => {
      await page.addInitScript(() => {
        window.__e2eMembers = ['opaque', 'transparent'].map((name) => ({
          user_id: `@${name}:example.test`,
          display_name: name,
          avatar_url: `mxc://example.test/${name}`,
          power_level: 0,
          membership: 'join',
          member_ts: null,
          kicked: false,
          service: false,
        }));
        window.__e2eFetchMedia = async (source) => {
          const canvas = new OffscreenCanvas(96, 96);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('No canvas context');
          context.fillStyle = source.endsWith('/transparent') ? '#ffffff' : '#ff0000';
          if (source.endsWith('/transparent')) context.fillRect(32, 32, 32, 32);
          else context.fillRect(0, 0, 96, 96);
          return new Uint8Array(
            await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
          );
        };
      });
      await installRoomCore('ready');
      await app.openRoom('!room:example.test');
      await timeline.expectRevealed();
      const subscription = await core.subscription();
      await core.setTimelineItemById(subscription, 'general-19', {
        ...timelineItem('general-19', 'Read this'),
        read_by: ['@opaque:example.test', '@transparent:example.test'],
      });
      const row = page.locator('[data-item-id="general-19"] .read-receipt-stack');
      await expect(row.locator('.avatar-root img')).toHaveCount(2);
      await expect
        .poll(() =>
          row
            .locator('img')
            .evaluateAll((images) =>
              images.every(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0
              )
            )
        )
        .toBe(true);
      const box = await row.locator('.avatar-root').nth(1).boundingBox();
      if (!box) throw new Error('Receipt avatar is not laid out');
      const clip = { x: box.x + 2, y: box.y + box.height / 2 - 2, width: 2, height: 4 };
      const withPrevious = await page.screenshot({ clip });
      await row
        .locator('.face-slot')
        .first()
        .evaluate((node: HTMLElement) => {
          node.style.visibility = 'hidden';
        });
      expect((await page.screenshot({ clip })).equals(withPrevious)).toBe(true);
    });
  });
}
