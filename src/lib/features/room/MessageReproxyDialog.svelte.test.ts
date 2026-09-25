// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import MessageReproxyDialog from './MessageReproxyDialog.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([
  { desktop: true, sheet: false },
  { desktop: false, sheet: true },
])('uses the draggable sheet only on mobile (desktop: $desktop)', async ({ desktop, sheet }) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: desktop,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const instance = mount(MessageReproxyDialog, {
    target: document.body,
    props: { open: true, personas: [], current: null, onChoose: () => {} },
  });
  await tick();

  expect(document.querySelector('.bottom-sheet-grip') !== null).toBe(sheet);
  expect(document.querySelector('.dialog-content-verification') !== null).toBe(!sheet);

  await unmount(instance);
});
