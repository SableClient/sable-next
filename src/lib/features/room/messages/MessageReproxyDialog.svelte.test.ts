// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
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
  render(MessageReproxyDialog, { open: true, personas: [], current: null, onChoose: () => {} });

  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector('.bottom-sheet-grip') !== null).toBe(sheet);
  expect(dialog.classList.contains('dialog-content-verification')).toBe(!sheet);
});
