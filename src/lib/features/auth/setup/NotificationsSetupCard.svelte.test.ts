// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const present = vi.hoisted(() => ({
  permissionState: vi.fn(() => Promise.resolve('prompt' as string)),
  grantPermission: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('#lib/features/notifications/present.js', () => present);
const prefs = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPreference: prefs.setPreference,
}));

import { core } from '#lib/core/__mocks__/context.js';

const setDefaultNotificationMode = vi.fn(() => Promise.resolve());
const defaultNotificationModes = vi.fn(() => Promise.resolve({ group: 'all', direct: 'all' }));
Object.assign(core, { setDefaultNotificationMode, defaultNotificationModes });

import NotificationsSetupCard from './NotificationsSetupCard.svelte';

async function setup(askDefault = true) {
  const props = { askDefault, onComplete: vi.fn(), onSkip: vi.fn() };
  render(NotificationsSetupCard, props);
  await vi.waitFor(() => {
    expect(present.permissionState).toHaveBeenCalled();
  });
  await Promise.resolve();
  flushSync();
  return { user: userEvent.setup(), ...props };
}

const button = (name: RegExp) => screen.queryByRole('button', { name });
const radio = (name: RegExp) => screen.queryByRole('radio', { name });
const continueButton = () => screen.getByRole('button', { name: /^Continue$/ });

afterEach(() => {
  vi.clearAllMocks();
});

test('all messages is the pre-selected group default, written to push rules', async () => {
  const { user, onComplete } = await setup();

  expect(radio(/All messages/)).toBeChecked();
  await user.click(continueButton());
  await vi.waitFor(() => {
    expect(onComplete).toHaveBeenCalledOnce();
  });
  expect(setDefaultNotificationMode).toHaveBeenCalledWith(false, 'all');
});

test('choosing mentions writes mentions instead', async () => {
  const { user } = await setup();

  await user.click(screen.getByRole('radio', { name: /Mentions and keywords/ }));
  await user.click(continueButton());
  await vi.waitFor(() => {
    expect(setDefaultNotificationMode).toHaveBeenCalledWith(false, 'mentions');
  });
});

test('shows the account’s saved group choice', async () => {
  defaultNotificationModes.mockResolvedValueOnce({ group: 'mentions', direct: 'all' });
  await setup();
  expect(radio(/Mentions and keywords/)).toBeChecked();
});

test('an account that already chose only asks this device for its permission', async () => {
  const { user, onComplete } = await setup(false);

  expect(radio(/All messages/)).not.toBeInTheDocument();
  await user.click(continueButton());
  expect(onComplete).toHaveBeenCalledOnce();
  expect(setDefaultNotificationMode).not.toHaveBeenCalled();
});

test('the OS prompt runs inside the click, and a grant turns the alerts on', async () => {
  await setup();

  void fireEvent.click(screen.getByRole('button', { name: /Allow notifications/ }));
  expect(present.grantPermission).toHaveBeenCalledOnce();
  await vi.waitFor(() => {
    expect(prefs.setPreference).toHaveBeenCalledWith('systemNotifications', true);
  });
  await vi.waitFor(() => {
    expect(button(/Allow notifications/)).not.toBeInTheDocument();
  });
  expect(screen.getByText(/Notifications are on/)).toBeInTheDocument();
});

test('a permission already denied is not asked for again', async () => {
  present.permissionState.mockResolvedValueOnce('denied');
  await setup();

  expect(button(/Allow notifications/)).not.toBeInTheDocument();
  expect(screen.getByText(/Notifications are off/)).toBeInTheDocument();
});

test('a failed write stays on the step and says so', async () => {
  setDefaultNotificationMode.mockRejectedValueOnce(new Error('offline'));
  const { user, onComplete } = await setup();

  await user.click(continueButton());
  expect(await screen.findByText(/couldn't be saved/)).toBeInTheDocument();
  expect(onComplete).not.toHaveBeenCalled();
});
