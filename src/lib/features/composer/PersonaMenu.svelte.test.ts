// @vitest-environment happy-dom

import { fireEvent, screen } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { expect, test, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';
import { preferences } from '#lib/settings/preferences.svelte.js';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import PersonaMenu from './PersonaMenu.svelte';
import { testPersona } from '#lib/personas/persona.ts';

function persona(id: string, color: string | null): PersonaView {
  return {
    ...testPersona,
    id,
    display_name: id,
    color_on_light: color,
    color_on_dark: color,
  };
}

test('a persona with a name colour is listed in that colour', async () => {
  renderWithTooltips(PersonaMenu, {
    personas: [persona('Tinted', '#c04040'), persona('Plain', null)],
    selected: null,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
  });
  const search = screen.getByRole('searchbox');
  await fireEvent.input(search, { target: { value: 'tinted' } });

  const tinted = screen.getByText('Tinted');
  expect(tinted).toHaveClass('tinted');
  expect(tinted.style.getPropertyValue('--name-color-on-light')).not.toBe('');

  await fireEvent.input(search, { target: { value: 'plain' } });
  expect(screen.getByText('Plain')).not.toHaveClass('tinted');
});

test('lists personas with duplicate IDs without crashing', () => {
  renderWithTooltips(PersonaMenu, {
    personas: [persona('duplicate', null), persona('duplicate', null)],
    selected: null,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
  });

  expect(screen.getAllByRole('button', { name: 'duplicate' })).toHaveLength(2);
});

test('the scope button cycles through the space only when the room is in one', async () => {
  const onScope = vi.fn();
  const props = {
    personas: [],
    selected: null,
    scope: 'room' as const,
    scopeChoice: true,
    onScope,
    onChoose: vi.fn(),
  };
  const { unmount } = renderWithTooltips(PersonaMenu, props);
  await fireEvent.click(screen.getByRole('button', { name: 'personas.rememberedRoom' }));
  expect(onScope).toHaveBeenLastCalledWith('account');
  unmount();

  renderWithTooltips(PersonaMenu, { ...props, hasSpace: true });
  await fireEvent.click(screen.getByRole('button', { name: 'personas.rememberedRoom' }));
  expect(onScope).toHaveBeenLastCalledWith('space');
});

test('the scope button is hidden unless scope is chosen in the picker', () => {
  renderWithTooltips(PersonaMenu, {
    personas: [],
    selected: null,
    scope: 'room',
    onScope: vi.fn(),
    onChoose: vi.fn(),
  });

  expect(screen.queryByRole('button', { name: 'personas.rememberedRoom' })).toBeNull();
});

test('the account profile is marked when no profile is held', () => {
  renderWithTooltips(PersonaMenu, {
    personas: [persona('Other', null)],
    selected: null,
    scope: 'space',
    hasSpace: true,
    onScope: vi.fn(),
    onChoose: vi.fn(),
  });

  expect(screen.getByRole('button', { name: 'personas.pickerOffGlobal' })).toHaveClass('selected');
  expect(screen.getByRole('button', { name: 'Other' })).not.toHaveClass('selected');
});

test('a saved alternate-avatar view falls back to the profile picker when no alternates exist', async () => {
  const previousMode = preferences.personaAlternateAvatar;
  preferences.personaAlternateAvatar = true;
  const selected = persona('Without alternates', null);
  const other = persona('Other profile', null);
  const onChoose = vi.fn();

  try {
    renderWithTooltips(PersonaMenu, {
      personas: [selected, other],
      selected: { persona_id: selected.id, alternate_avatar_id: null, valid_until: null },
      scope: 'account',
      onScope: vi.fn(),
      onChoose,
      onAlternateAvatarChoose: vi.fn(),
    });

    expect(screen.getByRole('searchbox')).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: other.display_name }));
    expect(onChoose).toHaveBeenCalledWith(other);
  } finally {
    preferences.personaAlternateAvatar = previousMode;
  }
});

test('the global option shows the account profile messages will be sent as', () => {
  renderWithTooltips(PersonaMenu, {
    personas: [],
    selected: null,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
    account: { id: '@alice:example.org', name: 'Alice', avatarUrl: null },
  });

  expect(screen.getByRole('button', { name: 'personas.pickerAccount:Alice' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'personas.pickerOffGlobal' })).toBeNull();
});
