// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, assert, expect, test, vi } from 'vitest';

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

  const [light, dark] = screen.getAllByRole('radio');
  expect(light).toBeChecked();
  expect(dark).not.toBeChecked();

  assert(dark);
  await user.click(dark);
  expect(prefs.setPreference).toHaveBeenCalledWith('theme', 'dark');
  assert(light);
  await user.click(light);
  expect(prefs.setPreference).toHaveBeenCalledWith('theme', 'system');

  const continueButton = screen.getAllByRole('button').at(-1);
  assert(continueButton);
  await user.click(continueButton);
  expect(onComplete).toHaveBeenCalledOnce();
});
