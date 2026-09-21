// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';

import ReceiptsDialog from './ReceiptsDialog.svelte';

test('uses the draggable sheet for read receipts on mobile', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const instance = mount(ReceiptsDialog, {
    target: document.body,
    props: {
      open: true,
      readers: [],
      members: [],
    },
  });
  await tick();

  expect(document.querySelector('.bottom-sheet-grip')).not.toBeNull();
  expect(document.querySelector('.bottom-sheet-handle')).not.toBeNull();

  await unmount(instance);
  vi.unstubAllGlobals();
});
