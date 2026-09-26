// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const prefs = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPreference: prefs.setPreference,
}));

import { core } from '#lib/core/__mocks__/context.js';

const accountData = vi.fn<(type: string) => Promise<unknown>>(() => Promise.resolve(null));
Object.assign(core, { accountData });

import SettingsSyncCard from './SettingsSyncCard.svelte';

async function setup() {
  const props = { onComplete: vi.fn(), onSkip: vi.fn() };
  render(SettingsSyncCard, props);
  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: /Turn on sync|Use synced settings/ })).toBeEnabled();
  });
  return { user: userEvent.setup(), ...props };
}

afterEach(() => {
  vi.clearAllMocks();
});

test('says the data is unencrypted before offering to turn sync on', async () => {
  const { user, onComplete } = await setup();

  expect(accountData).toHaveBeenCalledWith('moe.sable.next.settings');
  expect(screen.getByText(/unencrypted data/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Turn on sync' }));
  expect(prefs.setPreference).toHaveBeenCalledWith('settingsSync', true);
  expect(onComplete).toHaveBeenCalledOnce();
});

test('an account with synced settings is offered them to adopt', async () => {
  accountData.mockResolvedValueOnce({ version: 1, settings: {} });
  await setup();

  expect(screen.getByText(/Synced settings found/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use synced settings' })).toBeInTheDocument();
});

test('not now leaves sync off', async () => {
  const { user, onSkip } = await setup();

  await user.click(screen.getByRole('button', { name: 'Not now' }));
  expect(onSkip).toHaveBeenCalledOnce();
  expect(prefs.setPreference).not.toHaveBeenCalled();
});
