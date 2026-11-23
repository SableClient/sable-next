import { expect, onTestFinished, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import '../../../styles.css';
import { testPersona } from '#lib/personas/persona.ts';
import PersonaMenu from './PersonaMenu.svelte';

test('the search text starts after the magnifier', async () => {
  const screen = await render(PersonaMenu, {
    personas: [],
    selected: null,
    scope: 'account',
    onScope: vi.fn(),
    onChoose: vi.fn(),
    onAlternateAvatarChoose: vi.fn(),
  });

  const input = screen.getByRole('searchbox').element();
  const icon = input.parentElement?.querySelector('svg');
  if (!icon) throw new Error('the search field has no magnifier');
  const textStart =
    input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingInlineStart);

  expect(textStart).toBeGreaterThanOrEqual(icon.getBoundingClientRect().right);
});

test('Enter in the search picks the first match and consumes the key', async () => {
  const onChoose = vi.fn();
  const screen = await render(PersonaMenu, {
    personas: [{ ...testPersona, id: 'Tinted', display_name: 'Tinted' }],
    selected: null,
    scope: 'account',
    onScope: vi.fn(),
    onChoose,
  });
  const search = screen.getByRole('searchbox');
  let consumed = false;
  const record = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') consumed = event.defaultPrevented;
  };
  window.addEventListener('keydown', record);
  onTestFinished(() => {
    window.removeEventListener('keydown', record);
  });

  await userEvent.type(search, 'tin');
  await userEvent.keyboard('{Enter}');

  expect(onChoose).toHaveBeenCalledOnce();
  expect(consumed).toBe(true);
});
