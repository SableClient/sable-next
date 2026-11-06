// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { VerificationView } from '#src/generated/protocol';
import { CoreError } from '#src/transport';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('./VerificationQrScanner.svelte', async () => ({
  default: (await import('./ScannerStub.test.svelte')).default,
}));

import { core } from '#lib/core/__mocks__/context.js';

const encryption = {
  scanVerificationQr: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  startSasVerification: vi.fn(() => Promise.resolve()),
  confirmVerification: vi.fn(() => Promise.resolve()),
  cancelVerification: vi.fn(() => Promise.resolve()),
};
Object.assign(core, { rpc: { encryption }, session: { user_id: '@alice:example.org' } });

import DeviceVerificationDialog from './DeviceVerificationDialog.svelte';

const code = { width: 21, modules: '1'.repeat(21 * 21) };

function setup(state: VerificationView) {
  Object.assign(core, {
    verification: { userId: '@alice:example.org', flowId: 'flow', state },
  });
  render(DeviceVerificationDialog);
  return userEvent.setup();
}

const button = (name: RegExp) => screen.queryByRole('button', { name });
const qr = () => screen.queryByRole('img', { name: 'Verification code' });

afterEach(() => {
  vi.clearAllMocks();
  encryption.scanVerificationQr.mockReset().mockResolvedValue();
});

test('shows this device’s code with the logo, and offers the other ways', async () => {
  const user = setup({ phase: 'choose', qr: code, can_scan: true, can_compare: true });

  expect(qr()?.querySelector('image')).toBeInTheDocument();
  expect(button(/Scan a code instead/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Compare emoji instead/ }));
  expect(encryption.startSasVerification).toHaveBeenCalledWith({
    user_id: '@alice:example.org',
    flow_id: 'flow',
  });
});

test('a scanned code goes to the core as base64', async () => {
  const user = setup({ phase: 'choose', qr: code, can_scan: true, can_compare: false });

  await user.click(screen.getByRole('button', { name: /Scan a code instead/ }));
  expect(qr()).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'scan stub' }));

  await vi.waitFor(() => {
    expect(encryption.scanVerificationQr).toHaveBeenCalledWith({
      user_id: '@alice:example.org',
      flow_id: 'flow',
      data: 'TUH/',
    });
  });
  expect(qr()).not.toBeInTheDocument();
  expect(button(/scan stub/)).not.toBeInTheDocument();
  expect(button(/Compare emoji instead/)).not.toBeInTheDocument();
});

test('hides QR actions while a scan is pending', async () => {
  let finish!: () => void;
  encryption.scanVerificationQr.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const user = setup({ phase: 'choose', qr: code, can_scan: true, can_compare: true });
  await user.click(screen.getByRole('button', { name: /Scan a code instead/ }));
  await user.click(screen.getByRole('button', { name: 'scan stub' }));

  expect(qr()).not.toBeInTheDocument();
  expect(button(/scan stub/)).not.toBeInTheDocument();
  expect(button(/Compare emoji instead/)).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for the other device');
  finish();
});

test('shows scan errors and allows retry', async () => {
  encryption.scanVerificationQr.mockRejectedValueOnce(
    new CoreError({ code: 'invalid_verification_code' })
  );
  const user = setup({ phase: 'choose', qr: code, can_scan: true, can_compare: true });
  await user.click(screen.getByRole('button', { name: /Scan a code instead/ }));
  await user.click(screen.getByRole('button', { name: 'scan stub' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('That isn’t a verification code.');
  expect(button(/scan stub/)).toBeInTheDocument();
  expect(qr()).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'scan stub' }));
  expect(encryption.scanVerificationQr).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('without our own code, the scanner waits for a tap', async () => {
  const user = setup({ phase: 'choose', qr: null, can_scan: true, can_compare: true });

  expect(screen.getByText('How would you like to verify?')).toBeInTheDocument();
  expect(button(/scan stub/)).not.toBeInTheDocument();
  expect(button(/Compare emoji instead/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Scan a code with the camera' }));
  expect(button(/scan stub/)).toBeInTheDocument();
  expect(button(/Scan a code with the camera/)).not.toBeInTheDocument();
});

test('shows our code first', async () => {
  const user = setup({ phase: 'choose', qr: code, can_scan: true, can_compare: true });

  expect(button(/scan stub/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Scan a code instead/ }));
  expect(qr()).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show this device’s code' }));
  expect(qr()).toBeInTheDocument();
});

test('defaults to display when scanning is unsupported', () => {
  setup({ phase: 'choose', qr: code, can_scan: false, can_compare: true });

  expect(qr()).toBeInTheDocument();
  expect(button(/scan stub/)).not.toBeInTheDocument();
});

test('shows scan success while awaiting confirmation', () => {
  setup({ phase: 'reciprocated' });

  expect(screen.getByText('Code scanned. Confirm on your other device.')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for the other device');
  expect(qr()).not.toBeInTheDocument();
});

test('the other device scanning our code needs our confirmation', async () => {
  const user = setup({ phase: 'scanned' });

  await user.click(screen.getByRole('button', { name: /Yes, it worked/ }));
  expect(encryption.confirmVerification).toHaveBeenCalledWith({
    user_id: '@alice:example.org',
    flow_id: 'flow',
  });
  await user.click(screen.getByRole('button', { name: /^No$/ }));
  expect(encryption.cancelVerification).toHaveBeenCalledWith({
    user_id: '@alice:example.org',
    flow_id: 'flow',
    mismatch: true,
  });
});
