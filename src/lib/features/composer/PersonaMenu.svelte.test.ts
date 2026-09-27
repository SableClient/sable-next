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
