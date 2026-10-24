import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import type { Page } from '@playwright/test';

import type { RoomCoreMode } from './fake-core';
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';
import type { AppShell } from './pages/AppShell';
import type { FakeCoreDriver } from './pages/FakeCoreDriver';

test.use({ storageState: SIGNED_OUT, viewport: { width: 1100, height: 700 } });

const OWN = '@e2e:example.test';

function own(id: string, body: string): ResolvedItem {
  return { ...timelineItem(id, body), sender: OWN, sender_name: 'E2E', is_own: true };
}

async function openRoom(
  page: Page,
  app: AppShell,
  core: FakeCoreDriver,
  installRoomCore: (mode: RoomCoreMode) => Promise<void>,
  inlineEditing: boolean
): Promise<void> {
  await page.addInitScript((enabled) => {
    localStorage.setItem('sable-preferences', JSON.stringify({ inlineEditing: enabled }));
  }, inlineEditing);
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: [timelineItem('theirs', 'a message from someone else'), own('mine', 'hello world')],
    },
  ]);
}

test('an own message is edited where it appears, and saved with Enter', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await openRoom(page, app, core, installRoomCore, true);
  await app.composer.focus();
  await page.keyboard.press('ArrowUp');

  const row = page.locator('[data-item-id="mine"]');
  const editor = row.locator('[contenteditable="true"]');
  await expect(editor).toHaveText('hello world');
  await expect(editor).toBeFocused();
  await expect(app.composer).toHaveText('');

  await page.keyboard.press('End');
  await page.keyboard.type(' again');
  await page.keyboard.press('Enter');

  await expect(row.locator('[contenteditable="true"]')).toHaveCount(0);
  const edit = await page.evaluate(() =>
    window.__e2eCalls.find((call) => call.method === 'messages.edit')
  );
  expect(edit?.params).toMatchObject({ event_id: '$mine:example.test', body: 'hello world again' });
});

test('Escape leaves the message as it was', async ({ page, app, core, installRoomCore }) => {
  await openRoom(page, app, core, installRoomCore, true);
  await app.composer.focus();
  await page.keyboard.press('ArrowUp');
  const row = page.locator('[data-item-id="mine"]');
  await expect(row.locator('[contenteditable="true"]')).toBeFocused();

  await page.keyboard.type(' discarded');
  await page.keyboard.press('Escape');

  await expect(row.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(row).toContainText('hello world');
  await expect(row).not.toContainText('discarded');
  expect(
    await page.evaluate(() => window.__e2eCalls.some((call) => call.method === 'messages.edit'))
  ).toBe(false);
});

test('the composer takes over again when inline editing is off', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await openRoom(page, app, core, installRoomCore, false);
  await app.composer.focus();
  await page.keyboard.press('ArrowUp');

  await expect(app.composer).toContainText('hello world');
  await expect(page.locator('[data-item-id="mine"] [contenteditable="true"]')).toHaveCount(0);
});
