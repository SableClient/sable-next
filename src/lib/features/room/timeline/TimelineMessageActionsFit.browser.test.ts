import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { core } from '#lib/core/__mocks__/context.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import { item } from './timeline-item-fixtures';

afterEach(async () => {
  setPreference('expandedMessageActions', false);
  await page.viewport(414, 800);
});

const ownMessage = withRowFields({ ...item(false), is_own: true });

async function hoverToolbar(): Promise<{ row: HTMLElement; toolbar: HTMLElement }> {
  setPreference('expandedMessageActions', true);
  await render(TimelineItemHarness, {
    core,
    item: {
      item: ownMessage,
      collapsed: false,
      roomId: '!room:example.test',
      canPin: true,
      canRedactOwn: true,
      onReply: vi.fn(),
      onOpenThread: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
    },
  });
  const row = document.querySelector<HTMLElement>('article.message');
  if (!row) throw new Error('the message row is not rendered');
  await userEvent.hover(row);
  await expect.poll(() => row.querySelector('.message-actions')).not.toBeNull();
  const toolbar = row.querySelector<HTMLElement>('.message-actions');
  if (!toolbar) throw new Error('the toolbar is not rendered');
  return { row, toolbar };
}

const more = (toolbar: HTMLElement) => toolbar.querySelector('[aria-label="More actions"]');
const deleteButton = (toolbar: HTMLElement) =>
  toolbar.querySelector('[aria-label="Delete message"]');

test('a wide row shows every action inline without the overflow menu', async () => {
  await page.viewport(1280, 700);
  const { toolbar } = await hoverToolbar();

  await expect.poll(() => deleteButton(toolbar)).not.toBeNull();
  expect(more(toolbar)).toBeNull();
});

test('a narrow row keeps the toolbar on one line and moves the rest into the menu', async () => {
  await page.viewport(240, 700);
  const { row, toolbar } = await hoverToolbar();

  await expect.poll(() => more(toolbar)).not.toBeNull();
  expect(deleteButton(toolbar)).toBeNull();
  const box = toolbar.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(rowBox.left);
  expect(box.height).toBeLessThan(40);

  await userEvent.click(more(toolbar) as HTMLElement);
  await expect
    .poll(() => document.querySelector('[role="menuitem"]')?.closest('[role="menu"]')?.textContent)
    .toContain('Delete message');
});
