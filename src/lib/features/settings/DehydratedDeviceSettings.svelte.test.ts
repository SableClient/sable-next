// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { DehydratedDeviceView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
import { core as baseCore } from '#lib/core/__mocks__/context.js';
import DehydratedDeviceSettings from './DehydratedDeviceSettings.svelte';

const dehydratedDevice = vi.fn<() => Promise<DehydratedDeviceView>>();
const setDehydratedDevice =
  vi.fn<(params: { enabled: boolean }) => Promise<DehydratedDeviceView>>();
Object.assign(baseCore, {
  session: { account_id: 'a1' },
  encryption: null,
  rpc: { encryption: { dehydratedDevice, setDehydratedDevice } },
});

beforeEach(() => {
  dehydratedDevice.mockReset().mockResolvedValue('active');
  setDehydratedDevice.mockReset().mockResolvedValue('disabled');
});

test('turning the switch off disables the offline device', async () => {
  render(DehydratedDeviceSettings);
  const toggle = await screen.findByRole('switch', { name: 'Receive keys while offline' });
  expect(toggle).toHaveAttribute('aria-checked', 'true');

  await userEvent.click(toggle);

  expect(setDehydratedDevice).toHaveBeenCalledWith({ enabled: false });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('asks for the recovery key when no session holds the pickle key', async () => {
  dehydratedDevice.mockResolvedValue('needs_recovery_key');
  render(DehydratedDeviceSettings);
  expect(
    await screen.findByText('Unlock recovery with your recovery key to set up the offline device.')
  ).toBeInTheDocument();
});

test('stays hidden when the server does not support it', async () => {
  dehydratedDevice.mockResolvedValue('unsupported');
  render(DehydratedDeviceSettings);
  await vi.waitFor(() => {
    expect(dehydratedDevice).toHaveBeenCalled();
  });
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});
