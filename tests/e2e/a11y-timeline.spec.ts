import type { Locator, Page } from '@playwright/test';

import { tabStops, tabTo } from './fixtures/a11y';
import { LOGIN_PASSWORD } from './fixtures/loginAccount';
import { expect, test as base, SIGNED_OUT } from './fixtures/test';

const PAGE_ITEMS = 8;

const test = base.extend<{ feedSize: number; feedRoom: { roomId: string; newest: Locator } }>({
  feedSize: [80, { option: true }],
  feedRoom: async (
    { admin, guest, auth, app, page, homeserver, workerAccount, feedSize },
    use,
    testInfo
  ) => {
    const roomId = await admin.createRoom({
      name: `Feed ${String(testInfo.parallelIndex)} ${testInfo.testId}`,
      invite: [guest.userId],
    });
    await guest.join(roomId);
    for (let index = 0; index < feedSize; index += 1) {
      await admin.sendMessage(roomId, `Feed message ${String(index)}`);
    }
    await auth.open(homeserver.baseUrl);
    await auth.revealPasswordLogin();
    await auth.signInWithPassword(workerAccount.username, LOGIN_PASSWORD);
    await auth.finishSetup();
    await app.openRoom(roomId);

    const newest = feed(page)
      .getByRole('article')
      .filter({ hasText: `Feed message ${String(feedSize - 1)}` });
    await expect(newest).toBeVisible({ timeout: 30_000 });
    await page.getByRole('heading', { level: 1 }).focus();
    await tabTo(page, newest);
    await use({ roomId, newest });
  },
});

test.use({ storageState: SIGNED_OUT });

function feed(page: Page): Locator {
  return page.getByRole('feed', { name: 'Timeline' });
}

function focusedIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const match = /Feed message (\d+)/.exec(document.activeElement?.textContent ?? '');
    return match ? Number(match[1]) : -1;
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('Tab lands on the newest message and the feed is one tab stop', async ({
  page,
  feedRoom,
  feedSize,
}) => {
  void feedRoom;
  expect(await focusedIndex(page)).toBe(feedSize - 1);
  const stops = await tabStops(feed(page));
  expect(stops, stops.join('\n')).toHaveLength(1);

  await page.keyboard.press('Tab');
  await expect(feed(page).locator(':focus')).toHaveCount(0);
});

test('arrow, page, Home and End keys move between messages', async ({
  page,
  feedRoom,
  feedSize,
}) => {
  void feedRoom;
  const last = feedSize - 1;

  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusedIndex(page)).toBe(last - 1);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe(last);

  await page.keyboard.press('PageUp');
  await expect.poll(() => focusedIndex(page)).toBe(last - PAGE_ITEMS);
  await page.keyboard.press('PageDown');
  await expect.poll(() => focusedIndex(page)).toBe(last);

  await page.keyboard.press('Home');
  await expect.poll(() => focusedIndex(page)).toBeLessThan(last - PAGE_ITEMS);
  await page.keyboard.press('End');
  await expect.poll(() => focusedIndex(page)).toBe(last);
});

test.describe('with more than one page of history', () => {
  test.use({ feedSize: 300 });

  test('Up at the oldest loaded message loads older history', async ({ page, feedRoom }) => {
    void feedRoom;
    await page.keyboard.press('Home');
    await expect.poll(() => focusedIndex(page)).toBeGreaterThan(0);
    const oldestLoaded = await focusedIndex(page);

    await expect(async () => {
      await page.keyboard.press('ArrowUp');
      expect(await focusedIndex(page)).toBeLessThan(oldestLoaded);
    }).toPass();
  });
});

test('Enter moves into the message buttons and Escape comes back', async ({ page, feedRoom }) => {
  await page.keyboard.press('Enter');
  await expect(feedRoom.newest.locator('.message-actions button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(feedRoom.newest).toBeFocused();
});

test('Shift+F10 opens the message menu', async ({ page, feedRoom }) => {
  void feedRoom;
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('a message from someone else is announced with its sender', async ({
  page,
  guest,
  feedRoom,
}) => {
  await guest.sendMessage(feedRoom.roomId, 'Hello from the other side');

  await expect
    .poll(() => page.locator('[data-timeline-announcements]').textContent())
    .toBe('Ada: Hello from the other side');
});
