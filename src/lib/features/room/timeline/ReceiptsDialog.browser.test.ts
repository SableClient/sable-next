import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { expectScrollsInsideFrame } from '#lib/test-support/dialog-scroll.js';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({ holdOverlayBack: () => {} }));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import ReceiptsDialog from './ReceiptsDialog.svelte';

test('a long reader list on a short window scrolls inside the dialog, not the dialog itself', async () => {
  await page.viewport(1000, 500);
  const readers = Array.from({ length: 40 }, (_, index) => `@reader${index}:example.org`);
  await render(ReceiptsDialog, { open: true, readers, members: [] });
  await expect.element(page.getByRole('dialog')).toBeVisible();

  expectScrollsInsideFrame(page.getByRole('dialog').getByRole('list').element() as HTMLElement);
});
