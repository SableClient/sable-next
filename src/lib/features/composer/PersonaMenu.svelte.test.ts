// @vitest-environment happy-dom

import { fireEvent, screen } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { expect, test, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';
import { preferences } from '#lib/settings/preferences.svelte.js';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import PersonaMenu from './PersonaMenu.svelte';

function persona(id: string, color: string | null): PersonaView {
  return {
    id,
    display_name: id,
    avatar_url: null,
    pronouns: [],
    color_on_light: color,
    color_on_dark: color,
    triggers: [],
    pluralkit: null,
    last_used: null,
    alternate_avatars: null,
    biography: null,
    banner_url: null,
    is_animal: null,
    has_animal: null,
    animal_need: null,
  };
}

test('a persona with a name colour is listed in that colour', async () => {
  renderWithTooltips(PersonaMenu, {
    personas: [persona('Tinted', '#c04040'), persona('Plain', null)],
    selected: null,
    disabled: false,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onDisable: vi.fn(),
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
    disabled: false,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onDisable: vi.fn(),
  });

  expect(screen.getAllByRole('button', { name: 'duplicate' })).toHaveLength(2);
});

test('offers the space tab only when the room is in a space', () => {
  const props = {
    personas: [],
    selected: null,
    disabled: false,
    scope: 'space' as const,
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onDisable: vi.fn(),
  };
  const { unmount } = renderWithTooltips(PersonaMenu, props);
  expect(screen.queryByRole('tab', { name: 'personas.scopeSpace' })).toBeNull();
  unmount();

  renderWithTooltips(PersonaMenu, { ...props, hasSpace: true });
  expect(screen.getByRole('tab', { name: 'personas.scopeSpace' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(screen.getByRole('button', { name: 'personas.pickerSyncAccount' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'personas.pickerOffSpace' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'personas.pickerOff' })).toBeNull();
});

test('a space that is off marks its off option and not the default', () => {
  renderWithTooltips(PersonaMenu, {
    personas: [],
    selected: null,
    disabled: true,
    scope: 'space',
    hasSpace: true,
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onDisable: vi.fn(),
  });

  const off = screen.getByRole('button', { name: 'personas.pickerOffSpace' });
  expect(off).toHaveClass('selected');
  expect(screen.getByRole('button', { name: 'personas.pickerSyncAccount' })).not.toHaveClass(
    'selected'
  );
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
      disabled: false,
      scope: 'account',
      onScope: vi.fn(),
      onChoose,
      onAlternateAvatarChoose: vi.fn(),
      onDisable: vi.fn(),
    });

    expect(screen.getByRole('searchbox')).toBeVisible();
    expect(screen.getByRole('tablist')).toBeVisible();
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
    disabled: false,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onDisable: vi.fn(),
    account: { id: '@alice:example.org', name: 'Alice', avatarUrl: null },
  });

  expect(screen.getByRole('button', { name: 'personas.pickerAccount:Alice' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'personas.pickerOffGlobal' })).toBeNull();
});
