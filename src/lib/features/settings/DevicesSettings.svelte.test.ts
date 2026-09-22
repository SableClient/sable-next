// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { DeviceView, EncryptionStatusView } from '#src/generated/protocol';

const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/settings' }, params: {}, state: history.state },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));
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
};

const own: DeviceView = {
  device_id: 'OWN',
  display_name: 'This device',
  is_own: true,
  is_verified: true,
  last_seen_ts: null,
  last_seen_ip: null,
};

const other1: DeviceView = {
  device_id: 'DEV1',
  display_name: 'Phone',
  is_own: false,
  is_verified: true,
  last_seen_ts: null,
  last_seen_ip: null,
};

const other2: DeviceView = {
  device_id: 'DEV2',
  display_name: 'Tablet',
  is_own: false,
  is_verified: false,
  last_seen_ts: null,
  last_seen_ip: null,
};

afterEach(() => {
  history.state.overlay = undefined;
  document.body.replaceChildren();
});

test('signs out the selected devices in one batch', async () => {
  core.encryptionStatus.mockResolvedValue(status);
  core.devices.mockResolvedValue({ devices: [own, other1, other2], accountManagement: false });
  core.deleteDevice.mockResolvedValue(null);
  const instance = mount(DevicesSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.device').length).toBe(3);
  });

  document.querySelectorAll<HTMLInputElement>('.device-select').forEach((checkbox) => {
    checkbox.click();
  });
  await tick();

  document.querySelector<HTMLButtonElement>('.bulk-bar .btn-danger')?.click();
  await tick();

  document.querySelector<HTMLButtonElement>('.bulk-remove-form .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(core.deleteDevice).toHaveBeenCalledWith('DEV1', null);
    expect(core.deleteDevice).toHaveBeenCalledWith('DEV2', null);
  });

  await unmount(instance);
});

test('reports which devices failed instead of a blanket success', async () => {
  core.encryptionStatus.mockResolvedValue(status);
  core.devices.mockResolvedValue({ devices: [own, other1, other2], accountManagement: false });
  core.deleteDevice.mockImplementation((deviceId: string) =>
    deviceId === 'DEV2' ? Promise.reject(new Error('denied')) : Promise.resolve(null)
  );
  const instance = mount(DevicesSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.device').length).toBe(3);
  });

  document.querySelectorAll<HTMLInputElement>('.device-select').forEach((checkbox) => {
    checkbox.click();
  });
  await tick();

  document.querySelector<HTMLButtonElement>('.bulk-bar .btn-danger')?.click();
  await tick();

  document.querySelector<HTMLButtonElement>('.bulk-remove-form .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.settings-error')?.textContent).toContain('Tablet');
  });

  await unmount(instance);
});

test('renames the current device', async () => {
  core.encryptionStatus.mockResolvedValue(status);
  core.devices.mockResolvedValue({ devices: [own, other1, other2], accountManagement: false });
  const instance = mount(DevicesSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.device').length).toBe(3);
  });

  document.querySelectorAll<HTMLButtonElement>('.device-actions .btn')[0].click();
  await tick();

  const input = document.querySelectorAll<HTMLInputElement>('#device-OWN')[0];
  input.value = 'Laptop';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();

  document.querySelectorAll<HTMLFormElement>('.device-form')[0].requestSubmit();
  await vi.waitFor(() => {
    expect(core.renameDevice).toHaveBeenCalledWith('OWN', 'Laptop');
  });

  await unmount(instance);
});

test('asks for confirmation before resetting the recovery key', async () => {
  core.encryptionStatus.mockResolvedValue(status);
  core.devices.mockResolvedValue({ devices: [own], accountManagement: false });
  core.resetRecoveryKey.mockResolvedValue('NEW KEY');
  const instance = mount(DevicesSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelector('.setting-row .btn')).not.toBeNull();
  });

  document.querySelector<HTMLButtonElement>('.setting-row .btn')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.confirm')).not.toBeNull();
  });
  expect(core.resetRecoveryKey).not.toHaveBeenCalled();

  document.querySelector<HTMLButtonElement>('.confirm .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.recovery-key code')?.textContent).toBe('NEW KEY');
  });
  expect(core.resetRecoveryKey).toHaveBeenCalledOnce();

  await unmount(instance);
});
