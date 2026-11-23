import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { expectScrollsInsideFrame } from '#lib/test-support/dialog-scroll.js';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({ holdOverlayBack: () => {} }));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms: [] }) }));

import EditHistoryDialog from './EditHistoryDialog.svelte';

const versions = Array.from({ length: 20 }, (_, index) => ({
  event_id: `$edit${String(index)}`,
  timestamp: index + 1,
  body: `version ${String(index)}`,
  html: `<p>version ${String(index)}</p>`,
}));

test('a long edit history on a short window scrolls inside the dialog, not the dialog itself', async () => {
  await page.viewport(1000, 300);
  await render(EditHistoryDialog, { open: true, versions });
  await expect.element(page.getByRole('dialog')).toBeVisible();

  expectScrollsInsideFrame(page.getByRole('list').element() as HTMLElement);
});

test('a long edit history in a short sheet scrolls inside the sheet, not the sheet itself', async () => {
  await page.viewport(400, 360);
  await render(EditHistoryDialog, { open: true, versions });
  await expect.element(page.getByRole('dialog')).toBeVisible();

  expectScrollsInsideFrame(page.getByRole('list').element() as HTMLElement);
});
