// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';

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
  };
}

test('a persona with a name colour is listed in that colour', () => {
  render(PersonaMenu, {
    personas: [persona('Tinted', '#c04040'), persona('Plain', null)],
    selected: null,
    disabled: false,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onDisable: vi.fn(),
  });

  const tinted = screen.getByText('Tinted');
  expect(tinted).toHaveClass('tinted');
  expect(tinted.style.getPropertyValue('--name-color-on-light')).not.toBe('');
  expect(screen.getByText('Plain')).not.toHaveClass('tinted');
});

test('lists personas with duplicate IDs without crashing', () => {
  render(PersonaMenu, {
    personas: [persona('duplicate', null), persona('duplicate', null)],
    selected: null,
    disabled: false,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onDisable: vi.fn(),
  });

  expect(screen.getAllByText('duplicate')).toHaveLength(2);
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
  const { unmount } = render(PersonaMenu, props);
  expect(screen.queryByRole('tab', { name: 'personas.scopeSpace' })).toBeNull();
  unmount();

  render(PersonaMenu, { ...props, hasSpace: true });
  expect(screen.getByRole('tab', { name: 'personas.scopeSpace' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(screen.getByText('personas.pickerNone')).toBeInTheDocument();
  expect(screen.getByText('personas.pickerOffSpace')).toBeInTheDocument();
  expect(screen.queryByText('personas.pickerOff')).toBeNull();
});

test('a space that is off marks its off option and not the default', () => {
  render(PersonaMenu, {
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
  expect(off.querySelectorAll('svg')).toHaveLength(2);
  expect(
    screen.getByRole('button', { name: 'personas.pickerNone' }).querySelectorAll('svg')
  ).toHaveLength(0);
});
