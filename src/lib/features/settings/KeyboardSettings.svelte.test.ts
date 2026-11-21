// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { bindingFor, isRebound, resetAllBindings } from '#lib/ui/shortcuts/bindings.svelte.js';
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

test('removing a shortcut leaves it unbound until reset', async () => {
  const user = userEvent.setup();
  render(KeyboardSettings);
  const [first] = SHORTCUTS;

  const [remove] = screen.getAllByRole('button', { name: 'shortcuts.unbind' });
  await user.click(remove);

  expect(bindingFor(first.id)).toBe('');
  expect(screen.getByRole('button', { name: 'shortcuts.unbound' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'shortcuts.resetOne' }));
  expect(bindingFor(first.id)).toBe(first.binding);
});
