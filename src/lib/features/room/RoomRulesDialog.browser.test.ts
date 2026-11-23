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

import RoomRulesDialog from './RoomRulesDialog.svelte';
import type { RoomRules } from './room-rules.svelte.js';

test('long rules on a short window scroll inside the dialog, not the dialog itself', async () => {
  await page.viewport(1000, 300);
  const html = Array.from({ length: 40 }, (_, index) => `<p>Rule ${String(index)}</p>`).join('');
  const rules = {
    visible: true,
    removed: false,
    stale: false,
    blocking: false,
    accepting: false,
    shown: { html },
    dismiss: vi.fn(),
  } as unknown as RoomRules;
  await render(RoomRulesDialog, {
    rules,
    roomName: 'Room',
    sourceName: null,
    isSpace: false,
    onLeave: vi.fn(),
  });
  await expect.element(page.getByRole('dialog')).toBeVisible();

  expectScrollsInsideFrame(page.getByRole('region').element() as HTMLElement);
});
