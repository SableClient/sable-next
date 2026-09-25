// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const present = vi.hoisted(() => ({
  permissionState: vi.fn(() => Promise.resolve('granted' as string)),
}));
vi.mock('#lib/features/notifications/present.js', () => present);

import { core } from '#lib/core/__mocks__/context.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import SetupDoneCard from './SetupDoneCard.svelte';

function setEncryption(verification: string, recovery: string) {
  Object.assign(core, {
    encryption: { verification, recovery, cross_signing_ready: true, recovery_passphrase: false },
  });
}

async function render() {
  const onComplete = vi.fn();
  const instance = mount(SetupDoneCard, { target: document.body, props: { onComplete } });
  await vi.waitFor(() => {
    expect(present.permissionState).toHaveBeenCalled();
  });
  await Promise.resolve();
  flushSync();
  return { instance, onComplete };
}

const lines = () =>
  [...document.querySelectorAll('.setup-done-list li')].map((item) => ({
    text: item.textContent.trim(),
    done: item.classList.contains('done'),
  }));

afterEach(() => {
  document.body.replaceChildren();
  preferences.settingsSync = false;
  vi.clearAllMocks();
});

test('says where the device ended up, including what was skipped', async () => {
  setEncryption('unverified', 'disabled');
  present.permissionState.mockResolvedValueOnce('denied');
  const { instance } = await render();

  expect(lines()).toEqual([
    { text: 'Not confirmed yet', done: false },
    { text: 'No recovery key yet', done: false },
    { text: 'Notifications are off', done: false },
    { text: 'Settings stay on this device', done: false },
  ]);

  await unmount(instance);
});

test('a finished setup reads as finished, and the button leaves', async () => {
  setEncryption('verified', 'enabled');
  preferences.settingsSync = true;
  const { instance, onComplete } = await render();

  expect(lines().every((line) => line.done)).toBe(true);
  document.querySelector<HTMLButtonElement>('.setup-done-card button')?.click();
  expect(onComplete).toHaveBeenCalledOnce();

  await unmount(instance);
});
