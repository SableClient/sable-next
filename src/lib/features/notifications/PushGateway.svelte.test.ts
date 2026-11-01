// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/config/runtime-config.js', () => ({ runtimeConfig: () => Promise.resolve({}) }));
vi.mock('#lib/platform/push.js', () => ({
  supportsPushDistributors: vi.fn(() => Promise.resolve(true)),
  listPushDistributors: vi.fn(() => Promise.resolve(['ntfy', 'gotify'])),
}));
vi.mock('#lib/platform/notifications.js', () => ({
  deliversWebPush: () => false,
  deliversNativePush: () => true,
}));
vi.mock('./native-push.js', () => ({
  selectedPushDistributor: () => 'ntfy',
  selectedPushProvider: vi.fn(() => 'unifiedpush'),
  switchPushDistributor: vi.fn(),
  switchPushProvider: vi.fn(),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { selectedPushProvider, switchPushDistributor } from './native-push.js';
import PushGateway from './PushGateway.svelte';

test('the distributor snaps back when switching fails', async () => {
  Object.assign(core, { status: 'ready' });
  vi.mocked(switchPushDistributor).mockRejectedValueOnce(new Error('native failure'));
  const user = userEvent.setup();
  render(PushGateway);

  const trigger = () => screen.getByRole('combobox', { name: 'Notification distributor' });
  await screen.findByRole('combobox', { name: 'Notification distributor' });
  expect(trigger()).toHaveTextContent('ntfy');

  await user.click(trigger());
  await user.click(await screen.findByRole('option', { name: 'gotify' }));

  expect(await screen.findByText(/Could not update the notification distributor/)).toBeVisible();
  expect(switchPushDistributor).toHaveBeenCalledWith('gotify', expect.anything(), null, []);
  expect(trigger()).toHaveTextContent('ntfy');
});

test('the built-in connection saves its ntfy server only once it is a valid address', async () => {
  Object.assign(core, { status: 'ready' });
  vi.mocked(selectedPushProvider).mockReturnValue('embedded');
  const user = userEvent.setup();
  render(PushGateway);

  const field = await screen.findByRole('textbox', { name: 'ntfy server' });
  const [apply] = screen.getAllByRole('button', { name: 'Apply' });
  expect(await screen.findByText(/Leave this blank to use https:\/\/ntfy\.sh/)).toBeVisible();

  await user.type(field, 'http://ntfy.example.org');
  expect(screen.getByText(/An ntfy server is an https address/)).toBeVisible();
  expect(apply).toBeDisabled();

  await user.clear(field);
  await user.type(field, 'https://ntfy.example.org');
  await user.click(apply);
  expect(preferences.pushEmbeddedServerUrl).toBe('https://ntfy.example.org');

  await user.click(screen.getAllByRole('button', { name: 'Use the default' })[0]);
  expect(preferences.pushEmbeddedServerUrl).toBe('');
  expect(field).toHaveValue('');
});
