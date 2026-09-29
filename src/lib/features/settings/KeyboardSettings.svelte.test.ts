// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { isRebound, resetAllBindings } from '#lib/ui/shortcuts/bindings.svelte.js';
import { SHORTCUTS } from '#lib/ui/shortcuts/shortcuts.js';
import KeyboardSettings from './KeyboardSettings.svelte';

afterEach(() => {
  resetAllBindings();
});

test('Escape while recording cancels it without binding Escape or reaching the dialog', async () => {
  const user = userEvent.setup();
  const dialogEscape = vi.fn();
  const listen = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dialogEscape();
  };
  document.addEventListener('keydown', listen);
  render(KeyboardSettings);

  const [recorder] = screen.getAllByRole('button', { pressed: false });
  await user.click(recorder);
  expect(recorder).toHaveAttribute('aria-pressed', 'true');
  await user.keyboard('{Escape}');

  expect(recorder).toHaveAttribute('aria-pressed', 'false');
  expect(dialogEscape).not.toHaveBeenCalled();
  expect(SHORTCUTS.some((shortcut) => isRebound(shortcut.id))).toBe(false);
  document.removeEventListener('keydown', listen);
});
