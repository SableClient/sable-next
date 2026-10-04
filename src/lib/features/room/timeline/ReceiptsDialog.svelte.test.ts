// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { formatMessageTimestamp } from '#lib/ui/date-time.js';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

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

test.each([true, false])('shows only available reader times with desktop=%s', async (desktop) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: desktop,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const timestamp = 1_700_000_000_000;
  render(ReceiptsDialog, {
    open: true,
    readers: ['@bob:example.org', '@carol:example.org'],
    timestamps: { '@bob:example.org': timestamp },
    members: [],
  });

  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent(formatMessageTimestamp(timestamp));
  expect(dialog.querySelectorAll('time')).toHaveLength(1);
  expect(dialog.querySelector('time')?.closest('.member-identity-text')).toHaveTextContent(
    '@bob:example.org'
  );
});
