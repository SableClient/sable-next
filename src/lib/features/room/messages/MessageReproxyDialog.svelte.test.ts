// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';
import { BREAKPOINTS } from '#lib/ui/breakpoints.js';

import MessageReproxyDialog from './MessageReproxyDialog.svelte';
import { testPersona } from '#lib/personas/persona.ts';

function persona(id: string, display_name: string): PersonaView {
  return {
    ...testPersona,
    id,
    display_name,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([
  { desktop: true, sheet: false },
  { desktop: false, sheet: true },
])('uses the draggable sheet only on mobile (desktop: $desktop)', async ({ desktop, sheet }) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === BREAKPOINTS.wide && desktop,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  render(MessageReproxyDialog, { open: true, personas: [], current: null, onChoose: () => {} });

  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector('.bottom-sheet-grip') !== null).toBe(sheet);
  expect(dialog.classList.contains('dialog-content-verification')).toBe(!sheet);
});

test('filters personas by name or id and shows an empty state', async () => {
  const user = userEvent.setup();
  render(MessageReproxyDialog, {
    open: true,
    personas: [persona('kit', 'Kitty'), persona('wolf', 'Lupa')],
    current: null,
    onChoose: () => {},
  });

  const search = await screen.findByRole('searchbox', { name: 'Search profiles' });
  await user.type(search, 'KIT');
  expect(screen.getByRole('button', { name: 'Kitty' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Lupa' })).toBeNull();

  await user.clear(search);
  await user.type(search, 'wol');
  expect(screen.getByRole('button', { name: 'Lupa' })).toBeTruthy();

  await user.clear(search);
  await user.type(search, 'nobody');
  expect(screen.getByText('No profiles match that search.')).toBeTruthy();
});
