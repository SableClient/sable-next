import type { Locator, Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { MatrixAdmin } from './fixtures/matrix';

test.use({ storageState: SIGNED_OUT });

type Entry = { emoji: string; total: number };

async function history(account: MatrixAdmin): Promise<Entry[]> {
  const content = await account.request<{ recent_emoji: Entry[] }>(
    'GET',
    `client/v3/user/${encodeURIComponent(account.userId)}/account_data/m.recent_emoji`
  );
  return content.recent_emoji;
}

async function openPicker(page: Page, row: Locator): Promise<Locator> {
  await row.locator('article.message').click({ button: 'right' });
  await page.getByRole('menu').getByRole('button', { name: 'Add reaction', exact: true }).click();
  const picker = page.locator('.reaction-picker');
  await expect(picker).toBeVisible();
  return picker;
}

async function pick(page: Page, row: Locator, query: string, label: string): Promise<void> {
  const picker = await openPicker(page, row);
  await picker.getByRole('searchbox').fill(query);
  await picker.getByRole('gridcell', { name: label, exact: true }).click();
  await expect(picker).toBeHidden();
}

test('reaction history follows actual additions, frequency, removal, and reload', async ({
  page,
  app,
  timeline,
  freshLogin,
  guest,
}) => {
  const account = await freshLogin();
  const roomId = await account.createRoom({ name: 'Reaction history', invite: [guest.userId] });
  await guest.join(roomId);
  const first = await account.sendMessage(roomId, 'First reaction target');
  const second = await account.sendMessage(roomId, 'Second reaction target');
  const third = await account.sendMessage(roomId, 'Third reaction target');
  await guest.sendEvent(roomId, 'm.reaction', {
    'm.relates_to': { rel_type: 'm.annotation', event_id: third, key: '🎉' },
  });
  await app.openRoom(roomId);
  const firstRow = timeline.itemByEventId(first);
  const secondRow = timeline.itemByEventId(second);
  const thirdRow = timeline.itemByEventId(third);
  await expect(thirdRow).toBeVisible();

  await pick(page, firstRow, 'fire', 'fire');
  await expect(firstRow.locator('button.reaction').filter({ hasText: '🔥' })).toBeVisible();
  await pick(page, secondRow, 'fire', 'fire');
  await thirdRow.locator('button.reaction').filter({ hasText: '🎉' }).click();
  await expect
    .poll(async () => (await history(account)).map(({ emoji, total }) => [emoji, total]))
    .toEqual([
      ['🎉', 1],
      ['🔥', 2],
    ]);

  let picker = await openPicker(page, thirdRow);
  let cells = picker.locator('[data-section="recent"] [role="gridcell"]');
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(0)).toHaveAttribute('aria-label', 'fire');
  await expect(cells.nth(1)).toHaveAttribute('aria-label', 'tada');
  await page.keyboard.press('Escape');

  await firstRow.locator('button.reaction').filter({ hasText: '🔥' }).click();
  await expect(firstRow.locator('button.reaction').filter({ hasText: '🔥' })).toHaveCount(0);
  expect((await history(account)).map(({ emoji, total }) => [emoji, total])).toEqual([
    ['🎉', 1],
    ['🔥', 2],
  ]);

  await firstRow.locator('article.message').click({ button: 'right' });
  await page.locator('.quick-strip').getByRole('button', { name: 'fire', exact: true }).click();
  await expect.poll(async () => (await history(account))[0]?.total).toBe(3);

  const editor = page.locator('.composer [contenteditable="true"]').first();
  await editor.fill('+:fire');
  await editor.press('Enter');
  await expect.poll(async () => (await history(account))[0]?.total).toBe(4);

  await page.reload();
  await expect(thirdRow).toBeVisible();
  picker = await openPicker(page, thirdRow);
  cells = picker.locator('[data-section="recent"] [role="gridcell"]');
  await expect(cells).toHaveCount(2);
  await expect(cells.first()).toHaveAttribute('aria-label', 'fire');
});

test.describe('touch', () => {
  test.use({ hasTouch: true, viewport: { width: 412, height: 915 } });

  test('mobile: choosing a reaction from the sheet records exactly one use', async ({
    page,
    app,
    timeline,
    freshLogin,
  }) => {
    const account = await freshLogin();
    const roomId = await account.createRoom({ name: 'Mobile reaction history' });
    const target = await account.sendMessage(roomId, 'Mobile reaction target');
    await account.sendEvent(roomId, 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: target, key: '🔥' },
    });
    await app.openRoom(roomId);
    const row = timeline.itemByEventId(target);
    await row.locator('.reactions .add-reaction').click();
    const sheet = page.getByRole('dialog', { name: 'Add reaction', exact: true });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('searchbox').fill('tada');
    await sheet.getByRole('gridcell', { name: 'tada', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(row.locator('button.reaction').filter({ hasText: '🎉' })).toBeVisible();
    await expect
      .poll(async () => (await history(account)).map(({ emoji, total }) => [emoji, total]))
      .toEqual([['🎉', 1]]);
  });
});

test('synced history from another client is ranked by use and left as stored', async ({
  page,
  app,
  timeline,
  freshLogin,
}) => {
  const account = await freshLogin();
  const stored = [
    { emoji: '🎉', total: 2 },
    { emoji: '🔥', total: 84 },
    { emoji: '❤', total: 3 },
    { emoji: '❤️', total: 3 },
  ];
  await account.request(
    'PUT',
    `client/v3/user/${encodeURIComponent(account.userId)}/account_data/m.recent_emoji`,
    { recent_emoji: stored }
  );
  const roomId = await account.createRoom({ name: 'Synced reaction history' });
  const target = await account.sendMessage(roomId, 'Synced history target');
  await app.openRoom(roomId);
  const row = timeline.itemByEventId(target);
  await expect(row).toBeVisible();
  const picker = await openPicker(page, row);
  const cells = picker.locator('[data-section="recent"] [role="gridcell"]');
  await expect(cells).toHaveCount(3);
  await expect(cells.nth(0)).toHaveAttribute('aria-label', 'fire');
  await expect(cells.nth(1)).toHaveText('❤');
  await expect(cells.nth(2)).toHaveAttribute('aria-label', 'tada');
  expect(await history(account)).toEqual(stored);
});
