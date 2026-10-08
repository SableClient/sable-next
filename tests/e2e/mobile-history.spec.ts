import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';

test.use({
  storageState: SIGNED_OUT,
  hasTouch: true,
  viewport: { width: 412, height: 915 },
});

const historyLength = (page: Page): Promise<number> => page.evaluate(() => history.length);

async function pickRoom(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
  await expect(page.locator('#drawer-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name }).click();
  await expect(page.locator('#drawer-toggle')).toHaveAttribute('aria-pressed', 'false');
}

for (const source of ['reply', 'link']) {
  for (const returnToLive of [false, true]) {
    test(`mobile: back after ${source} jumps${returnToLive ? ' and jump to latest' : ''}`, async ({
      page,
      core,
      timeline,
      installRoomCore,
    }) => {
      await installRoomCore('ready');
      await page.goto('/rooms');
      await page.getByRole('link', { name: /^General/ }).click();
      await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
      await core.emitTimelineDiff(await core.subscription(), [
        {
          op: 'reset',
          values: [
            timelineItem('target-one', 'First target'),
            timelineItem('target-two', 'Second target'),
            ...historyItems({
              idPrefix: 'history',
              label: 'History',
              count: returnToLive ? 40 : 0,
              timestampBase: 1_700_000_000_000,
            }),
            ...['one', 'two'].map((id) => ({
              ...timelineItem(`jump-${id}`, `Jump ${id}`),
              content: {
                kind: 'message' as const,
                body: `Jump ${id}`,
                html: `<a href="https://matrix.to/#/!room:example.test/$target-${id}:example.test">Jump ${id}</a>`,
                emote: false,
                notice: false,
                edited: false,
              },
              in_reply_to: {
                event_id: `$target-${id}:example.test`,
                sender: '@alice:example.test',
                sender_mentioned: false,
                sender_name: 'Alice',
                body: `Target ${id}`,
              },
            })),
          ],
        },
      ]);

      for (const id of ['one', 'two']) {
        if (returnToLive) await timeline.scrollToBottomAndNotify();
        if (source === 'link') {
          await page.getByRole('link', { name: `Jump ${id}`, exact: true }).click();
        } else {
          await page.locator(`[data-event-id="$jump-${id}:example.test"] .reply-preview`).click();
        }
        await expect
          .poll(() => new URL(page.url()).searchParams.get('event'))
          .toBe(`$target-${id}:example.test`);
        await expect(page.locator(`[data-event-id="$target-${id}:example.test"]`)).toBeInViewport();
      }

      if (returnToLive) {
        await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
        await expect.poll(() => timeline.distanceFromBottom()).toBeLessThanOrEqual(1);
      }

      await page.goBack();
      await expect(page).toHaveURL(/\/rooms$/);
    });
  }
}

test('mobile: switching rooms from the list replaces the entry, so back leaves the stack', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/rooms');
  await page.getByRole('link', { name: /^General/ }).click();
  await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
  const general = page.url();
  const length = await historyLength(page);

  await pickRoom(page, /^Random/);
  expect(page.url()).not.toBe(general);
  await pickRoom(page, /^General/);
  await pickRoom(page, /^Random/);
  expect(await historyLength(page)).toBe(length);

  await page.goBack();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('mobile: a settings section pops to the menu, and close returns to the page that opened settings', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/rooms');
  await page.getByRole('link', { name: /^General/ }).click();
  await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
  await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
  await page.getByRole('link', { name: 'Manage accounts' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('link', { name: 'Timeline' }).click();
  await expect(page).toHaveURL(/\/settings\/timeline$/);
  const length = await historyLength(page);

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(await historyLength(page)).toBe(length);

  await page.getByRole('link', { name: 'Timeline' }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
});
