// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import ReceiptsDialog from './ReceiptsDialog.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('uses the draggable sheet for read receipts on mobile', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  render(ReceiptsDialog, { open: true, readers: [], members: [] });

  const sheet = await screen.findByRole('dialog');
  expect(sheet.querySelector('.bottom-sheet-grip')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close read receipts' })).toHaveClass(
    'bottom-sheet-handle'
  );
});
