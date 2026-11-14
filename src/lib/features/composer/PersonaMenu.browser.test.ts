import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import '../../../styles.css';
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
