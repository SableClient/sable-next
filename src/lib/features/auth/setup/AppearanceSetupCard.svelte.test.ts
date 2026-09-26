// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPreference: prefs.setPreference,
}));

import AppearanceSetupCard from './AppearanceSetupCard.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

test('shows both modes and follows the device when its mode is selected', async () => {
  const user = userEvent.setup();
  const onComplete = vi.fn();
  render(AppearanceSetupCard, { onComplete });

  expect(screen.getByText('Browse more themes')).toBeInTheDocument();
  expect(screen.getAllByRole('radio').map((choice) => choice.textContent.trim())).toEqual([
    'Light',
    'Dark',
  ]);
  expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked();

  await user.click(screen.getByRole('radio', { name: 'Dark' }));
  expect(prefs.setPreference).toHaveBeenCalledWith('theme', 'dark');
  await user.click(screen.getByRole('radio', { name: 'Light' }));
  expect(prefs.setPreference).toHaveBeenCalledWith('theme', 'system');

  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(onComplete).toHaveBeenCalledOnce();
});
