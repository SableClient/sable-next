// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { DeviceView, EncryptionStatusView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/state', () => ({
  page: { state: {}, url: new URL('http://localhost/setup/device') },
}));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  holdOverlayBack: vi.fn(),
  afterOverlayPops: () => Promise.resolve(),
}));
vi.mock('#lib/platform/external-auth.js', () => ({ openExternalAuthUrl: vi.fn() }));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const live = $state<{ encryption: EncryptionStatusView | null; deviceList: DeviceView[] }>({
  encryption: null,
  deviceList: [],
});

const core = Object.assign(baseCore, {
  session: { user_id: '@me:example.org', device_id: 'THIS' },
  requestVerification: vi.fn(() => Promise.resolve()),
  recoverIdentity: vi.fn(() => Promise.resolve()),
  resetIdentity: vi.fn(() => Promise.resolve({ step: 'done', recovery_key: 'new key' })),
  cancelIdentityReset: vi.fn(() => Promise.resolve()),
});
Object.defineProperties(core, {
  encryption: { get: () => live.encryption },
  deviceList: { get: () => live.deviceList },
});

import ConfirmDeviceCard from './ConfirmDeviceCard.svelte';

const status = (
  verification: EncryptionStatusView['verification'],
  recovery: EncryptionStatusView['recovery'] = 'enabled'
): EncryptionStatusView => ({
  verification,
  recovery,
  cross_signing_ready: false,
  recovery_passphrase: false,
});

const device = (device_id: string, is_own: boolean, is_verified: boolean): DeviceView => ({
  device_id,
  display_name: null,
  is_verified,
  is_own,
  last_seen_ts: null,
  last_seen_ip: null,
});

function render() {
  const props = { onComplete: vi.fn(), onSkip: vi.fn(), onReset: vi.fn() };
  const instance = mount(ConfirmDeviceCard, { target: document.body, props });
  flushSync();
  return { instance, ...props };
}

const button = (name: RegExp) =>
  [...document.querySelectorAll('button')].find((element) => name.test(element.textContent));

afterEach(() => {
  document.body.replaceChildren();
  live.encryption = null;
  live.deviceList = [];
  vi.clearAllMocks();
});

test('waits for the status instead of offering anything', async () => {
  const { instance, onComplete } = render();

  expect(document.body.textContent).toContain('Checking this device');
  expect(button(/Use recovery key/)).toBeUndefined();
  expect(onComplete).not.toHaveBeenCalled();

  await unmount(instance);
});

test('offers another device only when a confirmed one exists', async () => {
  live.encryption = status('unverified');
  live.deviceList = [device('THIS', true, false), device('OLD', false, false)];
  const { instance } = render();

  expect(button(/Use another device/)).toBeUndefined();
  expect(button(/Use recovery key/)).toBeDefined();

  live.deviceList = [device('THIS', true, false), device('PHONE', false, true)];
  flushSync();
  expect(button(/Use another device/)).toBeDefined();

  await unmount(instance);
});

test('with no other device and no recovery, reset is the one way forward', async () => {
  live.encryption = status('unverified', 'disabled');
  const { instance } = render();

  expect(document.body.textContent).toContain('has to be reset');
  expect(button(/Use recovery key/)).toBeUndefined();
  expect(button(/Reset my digital identity/)).toBeDefined();
  expect(button(/Can't confirm/)).toBeUndefined();

  await unmount(instance);
});

test('a device confirmed elsewhere shows it and waits for Continue', async () => {
  live.encryption = status('unverified');
  const { instance, onComplete } = render();

  live.encryption = status('verified');
  flushSync();

  expect(document.body.textContent).toContain('Device confirmed');
  expect(onComplete).not.toHaveBeenCalled();
  button(/Continue/)?.click();
  expect(onComplete).toHaveBeenCalledOnce();

  await unmount(instance);
});

test('skipping asks first, and only the second tap skips', async () => {
  live.encryption = status('unverified');
  const { instance, onSkip } = render();

  button(/Skip for now/)?.click();
  flushSync();
  expect(onSkip).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Skip confirming this device?');

  button(/Skip anyway/)?.click();
  await vi.waitFor(() => {
    expect(onSkip).toHaveBeenCalledOnce();
  });

  await unmount(instance);
});

test('a reset needs the acknowledgement and hands its recovery key on', async () => {
  live.encryption = status('unverified', 'disabled');
  const { instance, onReset } = render();

  button(/Reset my digital identity/)?.click();
  flushSync();
  const reset = button(/Reset my digital identity/);
  expect(reset?.disabled).toBe(true);

  const understood = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  understood?.click();
  flushSync();
  expect(reset?.disabled).toBe(false);

  reset?.click();
  await vi.waitFor(() => {
    expect(onReset).toHaveBeenCalledWith('new key');
  });

  await unmount(instance);
});

test('a device confirmed while its reset is running still hands the new key on', async () => {
  live.encryption = status('unverified', 'disabled');
  let finish: (step: { step: 'done'; recovery_key: string }) => void = () => {};
  core.resetIdentity.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const { instance, onReset, onComplete } = render();

  button(/Reset my digital identity/)?.click();
  flushSync();
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  flushSync();
  button(/Reset my digital identity/)?.click();
  flushSync();

  live.encryption = status('verified');
  flushSync();
  finish({ step: 'done', recovery_key: 'raced key' });

  await vi.waitFor(() => {
    expect(onReset).toHaveBeenCalledWith('raced key');
  });
  expect(onComplete).not.toHaveBeenCalled();

  await unmount(instance);
});
