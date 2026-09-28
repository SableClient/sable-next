// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { DeviceView, EncryptionStatusView } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  encryptionStatus: vi.fn<() => Promise<EncryptionStatusView>>(),
  devices: vi.fn<() => Promise<{ devices: DeviceView[]; accountManagement: boolean }>>(),
  deleteDevice: vi.fn<(deviceId: string, password: string | null) => Promise<string | null>>(),
  renameDevice: vi.fn<(deviceId: string, displayName: string) => Promise<void>>(),
  resetRecoveryKey: vi.fn<() => Promise<string>>(),
});

import DevicesSettings from './DevicesSettings.svelte';

const status: EncryptionStatusView = {
  verification: 'verified',
  recovery: 'enabled',
  cross_signing_ready: true,
  backup_unlocked: true,
  recovery_passphrase: false,
};

const own: DeviceView = {
  device_id: 'OWN',
  display_name: 'This device',
  is_own: true,
  is_verified: true,
  cross_signed: true,
  last_seen_ts: null,
  last_seen_ip: null,
};

const other1: DeviceView = {
  device_id: 'DEV1',
  display_name: 'Phone',
  is_own: false,
  is_verified: true,
  cross_signed: true,
  last_seen_ts: null,
  last_seen_ip: null,
};

const other2: DeviceView = {
  device_id: 'DEV2',
  display_name: 'Tablet',
  is_own: false,
  is_verified: false,
  cross_signed: false,
  last_seen_ts: null,
  last_seen_ip: null,
};

async function renderDevices(devices: DeviceView[]) {
  core.encryptionStatus.mockResolvedValue(status);
  core.devices.mockResolvedValue({ devices, accountManagement: false });
  render(DevicesSettings);
  await vi.waitFor(() => {
    expect(screen.getAllByText(/^(This device|Phone|Tablet)$/).length).toBeGreaterThanOrEqual(
      devices.length
    );
  });
  return userEvent.setup();
}

async function signOutOthers(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('checkbox', { name: 'Select Phone' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Tablet' }));
  const [bulk] = screen.getAllByRole('button', { name: 'Sign out selected' });
  await user.click(bulk);
  const confirm = screen.getAllByRole('button', { name: 'Sign out selected' }).at(-1);
  if (!confirm || confirm === bulk) throw new Error('no bulk sign-out confirmation');
  await user.click(confirm);
}

test('signs out the selected devices in one batch', async () => {
  core.deleteDevice.mockResolvedValue(null);
  const user = await renderDevices([own, other1, other2]);

  await signOutOthers(user);
  await vi.waitFor(() => {
    expect(core.deleteDevice).toHaveBeenCalledWith('DEV1', null);
    expect(core.deleteDevice).toHaveBeenCalledWith('DEV2', null);
  });
});

test('reports which devices failed instead of a blanket success', async () => {
  core.deleteDevice.mockImplementation((deviceId: string) =>
    deviceId === 'DEV2' ? Promise.reject(new Error('denied')) : Promise.resolve(null)
  );
  const user = await renderDevices([own, other1, other2]);

  await signOutOthers(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('Tablet');
});

test('renames the current device', async () => {
  const user = await renderDevices([own, other1, other2]);

  await user.click(screen.getAllByRole('button', { name: 'Rename This device' })[0]);
  const input = await screen.findByRole('textbox', { name: 'Device name' });
  await user.clear(input);
  await user.type(input, 'Laptop');
  await user.click(
    within(input.closest('form') ?? document.body).getByRole('button', { name: 'Save' })
  );

  await vi.waitFor(() => {
    expect(core.renameDevice).toHaveBeenCalledWith('OWN', 'Laptop');
  });
});

test('asks for confirmation before resetting the recovery key', async () => {
  core.resetRecoveryKey.mockResolvedValue('NEW KEY');
  const user = await renderDevices([own]);

  await user.click(await screen.findByRole('button', { name: 'Reset recovery key' }));
  const dialog = await screen.findByRole('dialog');
  expect(core.resetRecoveryKey).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('button', { name: 'Reset recovery key' }));
  expect(await screen.findByText('NEW KEY')).toBeInTheDocument();
  expect(core.resetRecoveryKey).toHaveBeenCalledOnce();
});
