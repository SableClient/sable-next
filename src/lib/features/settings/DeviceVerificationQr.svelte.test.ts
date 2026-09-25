// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { VerificationView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/state', () => ({ page: { state: {}, url: new URL('http://localhost/rooms') } }));
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

function render(state: VerificationView) {
  Object.assign(core, { verification: { flowId: 'flow', state } });
  const instance = mount(DeviceVerificationDialog, { target: document.body });
  flushSync();
  return instance;
}

const button = (name: RegExp) =>
  [...document.querySelectorAll('button')].find((element) => name.test(element.textContent.trim()));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('shows this device’s code with the logo, and offers the other ways', async () => {
  const instance = render({ phase: 'choose', qr: code, can_scan: true, can_compare: true });

  expect(document.querySelector('svg[aria-label="Verification code"] image')).not.toBeNull();
  expect(button(/Scan their code instead/)).toBeDefined();
  button(/Compare emoji instead/)?.click();
  expect(commands.startSasVerification).toHaveBeenCalledWith('@alice:example.org', 'flow');

  await unmount(instance);
});

test('a scanned code goes to the core as base64', async () => {
  const instance = render({ phase: 'choose', qr: code, can_scan: true, can_compare: false });

  button(/Scan their code instead/)?.click();
  flushSync();
  expect(document.querySelector('svg[aria-label="Verification code"]')).toBeNull();
  button(/scan stub/)?.click();

  await vi.waitFor(() => {
    expect(commands.scanVerificationQr).toHaveBeenCalledWith('@alice:example.org', 'flow', 'TUH/');
  });
  expect(button(/Compare emoji instead/)).toBeUndefined();

  await unmount(instance);
});

test('without a code of our own, the scanner opens straight away', async () => {
  const instance = render({ phase: 'choose', qr: null, can_scan: true, can_compare: true });

  expect(button(/scan stub/)).toBeDefined();
  expect(button(/Scan their code instead/)).toBeUndefined();

  await unmount(instance);
});

test('the other device scanning our code needs our confirmation', async () => {
  const instance = render({ phase: 'scanned' });

  button(/Yes, it worked/)?.click();
  expect(commands.confirmVerification).toHaveBeenCalledWith('@alice:example.org', 'flow');
  button(/^No$/)?.click();
  expect(commands.cancelVerification).toHaveBeenCalledWith('@alice:example.org', 'flow', true);

  await unmount(instance);
});
