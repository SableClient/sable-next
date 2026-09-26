// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const present = vi.hoisted(() => ({
  permissionState: vi.fn(() => Promise.resolve('granted' as string)),
}));
vi.mock('#lib/features/notifications/present.js', () => present);

import { core } from '#lib/core/__mocks__/context.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

Object.assign(core, {
  defaultNotificationModes: vi.fn(() => Promise.resolve({ group: 'all', direct: 'all' })),
});

import SetupDoneCard from './SetupDoneCard.svelte';

function setEncryption(verification: string, recovery: string) {
  Object.assign(core, {
    encryption: { verification, recovery, cross_signing_ready: true, recovery_passphrase: false },
  });
}

async function setup() {
  const onComplete = vi.fn();
  render(SetupDoneCard, { active: true, onComplete });
  await vi.waitFor(() => {
    expect(present.permissionState).toHaveBeenCalled();
  });
  await Promise.resolve();
  flushSync();
  return { onComplete };
}

const lines = () =>
  screen.getAllByRole('listitem').map((item) => ({
    text: item.textContent.trim(),
    done: item.classList.contains('done'),
  }));

afterEach(() => {
  preferences.settingsSync = false;
  vi.clearAllMocks();
});

test('says where the device ended up, including what was skipped', async () => {
  setEncryption('unverified', 'disabled');
  present.permissionState.mockResolvedValueOnce('denied');
  await setup();

  expect(lines()).toEqual([
    { text: 'Not confirmed yet', done: false },
    { text: 'No recovery key yet', done: false },
    { text: 'Notifications are off', done: false },
    { text: 'Group chats: all messages', done: true },
    { text: 'Settings stay on this device', done: false },
  ]);
});

test('a finished setup reads as finished, and the button leaves', async () => {
  setEncryption('verified', 'enabled');
  preferences.settingsSync = true;
  const user = userEvent.setup();
  const { onComplete } = await setup();

  expect(lines().every((line) => line.done)).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Go to your chats' }));
  expect(onComplete).toHaveBeenCalledOnce();
});
