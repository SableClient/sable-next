// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { VerificationView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));
vi.mock('$app/state', () => ({
  page: { state: history.state, url: new URL('http://localhost/rooms') },
}));
vi.mock('./VerificationQrScanner.svelte', async () => ({
  default: (await import('./ScannerStub.test.svelte')).default,
}));

import { core } from '#lib/core/__mocks__/context.js';

const commands = {
  scanVerificationQr: vi.fn(() => Promise.resolve()),
  startSasVerification: vi.fn(() => Promise.resolve()),
  confirmVerification: vi.fn(() => Promise.resolve()),
  cancelVerification: vi.fn(() => Promise.resolve()),
};
Object.assign(core, commands, { session: { user_id: '@alice:example.org' } });

import DeviceVerificationDialog from './DeviceVerificationDialog.svelte';

const code = { width: 21, modules: '1'.repeat(21 * 21) };

function setup(state: VerificationView) {
  Object.assign(core, { verification: { flowId: 'flow', state } });
  render(DeviceVerificationDialog);
  return userEvent.setup();
}

const button = (name: RegExp) => screen.queryByRole('button', { name });
const qr = () => screen.queryByRole('img', { name: 'Verification code' });

afterEach(() => {
  history.state.overlay = undefined;
  vi.clearAllMocks();
});

test('shows this device’s code with the logo, and offers the other ways', async () => {
  const user = setup({ phase: 'choose', qr: code, can_scan: true, can_compare: true });

  expect(qr()?.querySelector('image')).toBeInTheDocument();
  expect(button(/Scan their code instead/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Compare emoji instead/ }));
  expect(commands.startSasVerification).toHaveBeenCalledWith('@alice:example.org', 'flow');
});

test('a scanned code goes to the core as base64', async () => {
  const user = setup({ phase: 'choose', qr: code, can_scan: true, can_compare: false });

  await user.click(screen.getByRole('button', { name: /Scan their code instead/ }));
  expect(qr()).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'scan stub' }));

  await vi.waitFor(() => {
    expect(commands.scanVerificationQr).toHaveBeenCalledWith('@alice:example.org', 'flow', 'TUH/');
  });
  expect(button(/Compare emoji instead/)).not.toBeInTheDocument();
});

test('without a code of our own, the scanner opens straight away', () => {
  setup({ phase: 'choose', qr: null, can_scan: true, can_compare: true });

  expect(button(/scan stub/)).toBeInTheDocument();
  expect(button(/Scan their code instead/)).not.toBeInTheDocument();
});

test('the other device scanning our code needs our confirmation', async () => {
  const user = setup({ phase: 'scanned' });

  await user.click(screen.getByRole('button', { name: /Yes, it worked/ }));
  expect(commands.confirmVerification).toHaveBeenCalledWith('@alice:example.org', 'flow');
  await user.click(screen.getByRole('button', { name: /^No$/ }));
  expect(commands.cancelVerification).toHaveBeenCalledWith('@alice:example.org', 'flow', true);
});
