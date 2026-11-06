// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import {
  type CoreEvent,
  type DeviceView,
  type EncryptionStatusView,
  type Rpc,
} from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/platform/external-auth.js', () => ({
  openExternalAuthUrl: vi.fn(() => Promise.resolve()),
  openExternalAuthWindow: vi.fn(),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const encryption = {
  status: vi.fn<() => Promise<EncryptionStatusView>>(),
  devices: vi.fn<Rpc['encryption']['devices']>(),
  deleteDevice:
    vi.fn<(params: { device_id: string; password: string | null }) => Promise<string | null>>(),
  renameDevice: vi.fn<(params: { device_id: string; display_name: string }) => Promise<void>>(),
  resetRecoveryKey: vi.fn<() => Promise<string>>(),
  enableRecovery: vi.fn<Rpc['encryption']['enableRecovery']>(),
  keyBackupStatus: vi.fn().mockResolvedValue({
    local_keys: 0,
    backed_up_keys: 0,
    cloud_keys: 0,
    can_restore: true,
    download: null,
  }),
  dehydratedDevice: vi.fn<Rpc['encryption']['dehydratedDevice']>().mockResolvedValue('unsupported'),
};
Object.assign(baseCore, { rpc: { encryption } });

import { CoreError } from '#src/transport';
import DevicesSettings from './DevicesSettings.svelte';
import { openExternalAuthUrl, openExternalAuthWindow } from '#lib/platform/external-auth.js';

const status: EncryptionStatusView = {
  verification: 'verified',
  recovery: 'enabled',
  cross_signing_ready: true,
  backup_unlocked: true,
  signing_keys: { master: true, self_signing: true, user_signing: true },
  recovery_passphrase: false,
  account_data_key: false,
};

const own: DeviceView = {
  device_id: 'OWN',
  display_name: 'This device',
  is_own: true,
  is_verified: true,
  has_keys: true,
  cross_signed: true,
  last_seen_ts: null,
  last_seen_ip: null,
};

const other1: DeviceView = {
  device_id: 'DEV1',
  display_name: 'Phone',
  is_own: false,
  is_verified: true,
  has_keys: true,
  cross_signed: true,
  last_seen_ts: null,
  last_seen_ip: null,
};

const other2: DeviceView = {
  device_id: 'DEV2',
  display_name: 'Tablet',
  is_own: false,
  is_verified: false,
  has_keys: true,
  cross_signed: false,
  last_seen_ts: null,
  last_seen_ip: null,
};

function emit(event: CoreEvent): void {
  const [listener] = baseCore.subscribeEvents.mock.lastCall as unknown as [
    (event: CoreEvent) => void,
  ];
  listener(event);
}

async function renderDevices(devices: DeviceView[], managementUrl: string | null = null) {
  encryption.status.mockResolvedValue(status);
  encryption.devices.mockResolvedValue({
    devices,
  });
  vi.spyOn(baseCore, 'oauthMetadata', 'get').mockImplementation(() => ({
    account_management_uri: managementUrl,
    account_management_actions_supported: [],
  }));

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
  encryption.deleteDevice.mockResolvedValue(null);
  const user = await renderDevices([own, other1, other2]);
  expect(screen.queryByRole('link', { name: 'Devices dashboard' })).not.toBeInTheDocument();

  await signOutOthers(user);
  await vi.waitFor(() => {
    expect(encryption.deleteDevice).toHaveBeenCalledWith({ device_id: 'DEV1', password: null });
    expect(encryption.deleteDevice).toHaveBeenCalledWith({ device_id: 'DEV2', password: null });
  });
});

test('the server devices dashboard is a plain external link, not an auth popup', async () => {
  const url = 'https://id.example.org/account?action=org.matrix.sessions_list';
  await renderDevices([own, other1], url);

  const dashboard = screen.getByRole('link', { name: 'Devices dashboard' });
  expect(dashboard).toHaveAttribute('href', url);
  expect(dashboard).toHaveAttribute('target', '_blank');
  dashboard.addEventListener(
    'click',
    (event) => {
      event.preventDefault();
    },
    { once: true }
  );
  dashboard.click();
  expect(openExternalAuthUrl).not.toHaveBeenCalled();
  expect(openExternalAuthWindow).not.toHaveBeenCalled();
});

test('device removal opens account management without asking for a password', async () => {
  const url = 'https://id.example.org/account?action=org.matrix.session_end&device_id=DEV1';
  const navigate = vi.fn(() => Promise.resolve(false));
  vi.mocked(openExternalAuthWindow).mockReturnValue({ navigate, close: vi.fn() });
  encryption.deleteDevice.mockResolvedValue(url);
  const user = await renderDevices([own, other1], 'https://id.example.org/account');

  await user.click(screen.getByRole('button', { name: 'Options for Phone' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));

  await vi.waitFor(() => {
    expect(navigate).toHaveBeenCalledWith(url);
  });
  expect(encryption.deleteDevice).toHaveBeenCalledWith({ device_id: 'DEV1', password: null });
  expect(screen.queryByLabelText('Password (if required)')).not.toBeInTheDocument();
});

test('reports which devices failed instead of a blanket success', async () => {
  encryption.deleteDevice.mockImplementation(({ device_id }) =>
    device_id === 'DEV2' ? Promise.reject(new Error('denied')) : Promise.resolve(null)
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
    expect(encryption.renameDevice).toHaveBeenCalledWith({
      device_id: 'OWN',
      display_name: 'Laptop',
    });
  });
});

test('asks for confirmation before resetting the recovery key', async () => {
  encryption.resetRecoveryKey.mockResolvedValue('NEW KEY');
  const user = await renderDevices([own]);

  await user.click(await screen.findByRole('button', { name: 'Reset recovery key' }));
  const dialog = await screen.findByRole('dialog');
  expect(encryption.resetRecoveryKey).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('button', { name: 'Reset recovery key' }));
  expect(await screen.findByText('NEW KEY')).toBeInTheDocument();
  expect(encryption.resetRecoveryKey).toHaveBeenCalledOnce();
});

test('an unreadable server backup asks before it is replaced', async () => {
  encryption.enableRecovery
    .mockRejectedValueOnce(new CoreError({ code: 'backup_exists' }))
    .mockResolvedValueOnce('NEW KEY');
  encryption.status.mockResolvedValue({ ...status, recovery: 'disabled' });
  encryption.devices.mockResolvedValue({ devices: [own] });
  render(DevicesSettings);
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'Set up recovery' }));
  const dialog = await screen.findByRole('dialog');
  expect(encryption.enableRecovery).toHaveBeenCalledWith({
    passphrase: null,
    replace_backup: false,
  });

  await user.click(within(dialog).getByRole('button', { name: 'Replace backup' }));
  expect(await screen.findByText('NEW KEY')).toBeInTheDocument();
  expect(encryption.enableRecovery).toHaveBeenLastCalledWith({
    passphrase: null,
    replace_backup: true,
  });
});

test('a session without device keys says so and offers no verification', async () => {
  await renderDevices([own, { ...other2, has_keys: false }, { ...other1, is_verified: false }]);

  const keyless = screen.getByText('Tablet').closest('li');
  const unverified = screen.getByText('Phone').closest('li');
  if (!keyless || !unverified) throw new Error('the device rows are not laid out');
  expect(within(keyless).getByText('No encryption keys')).toBeInTheDocument();
  expect(within(keyless).queryByRole('button', { name: 'Verify device' })).not.toBeInTheDocument();
  expect(within(unverified).getByText('Not verified')).toBeInTheDocument();
  expect(within(unverified).getByRole('button', { name: 'Verify device' })).toBeInTheDocument();
});

test('updates device badges when verification completes while settings is open', async () => {
  await renderDevices([own, other2]);
  const row = screen.getByText('Tablet').closest('li');
  if (!row) throw new Error('the device row is not laid out');
  expect(within(row).getByText('Not verified')).toBeInTheDocument();

  emit({
    type: 'devices_changed',
    devices: [own, { ...other2, is_verified: true, cross_signed: true }],
  });

  await vi.waitFor(() => {
    expect(within(row).getByText('Verified')).toBeInTheDocument();
  });
  expect(within(row).queryByRole('button', { name: 'Verify device' })).not.toBeInTheDocument();
});

test('keeps live trust updates when an older settings refresh finishes', async () => {
  const user = await renderDevices([own]);
  let finishStatus!: (value: EncryptionStatusView) => void;
  let finishDevices!: (value: Awaited<ReturnType<Rpc['encryption']['devices']>>) => void;
  encryption.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStatus = resolve;
      })
  );
  encryption.devices.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDevices = resolve;
      })
  );
  const section = screen.getByRole('heading', { name: 'Signed-in devices' }).closest('section');
  const refresh = within(section ?? document.body).getByRole('button', { name: 'Refresh' });
  await user.click(refresh);

  emit({ type: 'encryption_status', status });
  emit({ type: 'devices_changed', devices: [own, other1] });
  finishStatus({ ...status, verification: 'unverified' });
  finishDevices({
    devices: [{ ...own, is_verified: false, cross_signed: false }],
  });

  await vi.waitFor(() => {
    expect(refresh).toBeEnabled();
  });
  expect(screen.queryByRole('button', { name: 'Verify device' })).not.toBeInTheDocument();
  expect(screen.getByText('Phone')).toBeInTheDocument();
});

test('removing one device shows it is in progress until the list no longer has it', async () => {
  const user = await renderDevices([own, other1]);
  let answer: (value: string | null) => void = () => {};
  encryption.deleteDevice.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );

  await user.click(screen.getByRole('button', { name: 'Options for Phone' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
  await vi.waitFor(() => {
    expect(document.body.style.pointerEvents).toBe('');
  });
  await user.type(screen.getByLabelText('Password (if required)'), 'hunter2');
  const confirm = screen.getByRole('button', { name: 'Remove device' });
  await user.click(confirm);

  expect(encryption.deleteDevice).toHaveBeenCalledWith({ device_id: 'DEV1', password: 'hunter2' });
  expect(confirm).toHaveAttribute('aria-busy', 'true');
  expect(confirm).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

  encryption.devices.mockResolvedValue({
    devices: [own],
  });
  answer(null);
  await vi.waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Remove device' })).not.toBeInTheDocument();
  });
});

test('a verified session missing its master key explains it instead of asking to unlock', async () => {
  encryption.status.mockResolvedValue({
    ...status,
    recovery: 'incomplete',
    backup_unlocked: true,
    signing_keys: { master: false, self_signing: true, user_signing: true },
  });
  encryption.devices.mockResolvedValue({
    devices: [own],
  });
  render(DevicesSettings);

  expect(await screen.findByText('Some signing keys are not on this device')).toBeInTheDocument();
  expect(screen.getByText(/It is missing your master key,/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Fetch missing keys' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();
  expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
});

test('a verified session whose key backup is still locked keeps the unlock action', async () => {
  encryption.status.mockResolvedValue({
    ...status,
    recovery: 'incomplete',
    backup_unlocked: false,
    signing_keys: { master: false, self_signing: true, user_signing: true },
  });
  encryption.devices.mockResolvedValue({
    devices: [own],
  });
  render(DevicesSettings);

  expect(await screen.findByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  expect(screen.queryByText('Some signing keys are not on this device')).not.toBeInTheDocument();
});
