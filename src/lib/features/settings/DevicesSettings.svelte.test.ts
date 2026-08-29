// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { DeviceView } from '#src/generated/DeviceView';
import type { EncryptionStatusView } from '#src/generated/EncryptionStatusView';

const core = vi.hoisted(() => {
  const stub = {
    encryptionStatus: vi.fn<() => Promise<EncryptionStatusView>>(),
    devices: vi.fn<() => Promise<{ devices: DeviceView[]; accountManagement: boolean }>>(),
    deleteDevice: vi.fn<(deviceId: string, password: string | null) => Promise<string | null>>(),
    subscribeEvents: vi.fn(() => () => {}),
  };

  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

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

  document.querySelector<HTMLButtonElement>('.bulk-bar .sable-button-danger')?.click();
  await tick();

  document.querySelector<HTMLButtonElement>('.bulk-remove-form .sable-button-danger')?.click();
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

  document.querySelector<HTMLButtonElement>('.bulk-bar .sable-button-danger')?.click();
  await tick();

  document.querySelector<HTMLButtonElement>('.bulk-remove-form .sable-button-danger')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.settings-error')?.textContent).toContain('Tablet');
  });

  await unmount(instance);
});
