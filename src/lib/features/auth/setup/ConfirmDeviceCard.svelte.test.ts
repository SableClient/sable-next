// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { DeviceView, EncryptionStatusView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
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
  backup_unlocked: false,
  recovery_passphrase: false,
});

const device = (device_id: string, is_own: boolean, cross_signed: boolean): DeviceView => ({
  device_id,
  display_name: null,
  is_verified: false,
  cross_signed,
  is_own,
  last_seen_ts: null,
  last_seen_ip: null,
});

function setup() {
  const props = { onComplete: vi.fn(), onSkip: vi.fn(), onReset: vi.fn() };
  render(ConfirmDeviceCard, props);
  return { user: userEvent.setup(), ...props };
}

const button = (name: RegExp) => screen.queryByRole('button', { name });
const press = (user: ReturnType<typeof userEvent.setup>, name: RegExp) =>
  user.click(screen.getByRole('button', { name }));

afterEach(() => {
  live.encryption = null;
  live.deviceList = [];
  vi.clearAllMocks();
});

test('waits for the status instead of offering anything', () => {
  const { onComplete } = setup();

  expect(screen.getByText(/Checking this device/)).toBeInTheDocument();
  expect(button(/Use recovery key/)).not.toBeInTheDocument();
  expect(onComplete).not.toHaveBeenCalled();
});

test('offers another device only when one is cross-signed by the account', () => {
  live.encryption = status('unverified');
  live.deviceList = [device('THIS', true, false), device('OLD', false, false)];
  setup();

  expect(button(/Use another device/)).not.toBeInTheDocument();
  expect(button(/Use recovery key/)).toBeInTheDocument();

  live.deviceList = [device('THIS', true, false), device('PHONE', false, true)];
  flushSync();
  expect(button(/Use another device/)).toBeInTheDocument();
});

test('with no other device and no recovery, reset is the one way forward', () => {
  live.encryption = status('unverified', 'disabled');
  setup();

  expect(screen.getByText(/has to be reset/)).toBeInTheDocument();
  expect(button(/Use recovery key/)).not.toBeInTheDocument();
  expect(button(/Reset my digital identity/)).toBeInTheDocument();
  expect(button(/Can't confirm/)).not.toBeInTheDocument();
});

test('a device confirmed elsewhere shows it and waits for Continue', async () => {
  live.encryption = status('unverified');
  const { user, onComplete } = setup();

  live.encryption = status('verified');
  flushSync();

  expect(screen.getByText(/Device confirmed/)).toBeInTheDocument();
  expect(onComplete).not.toHaveBeenCalled();
  await press(user, /Continue/);
  expect(onComplete).toHaveBeenCalledOnce();
});

test('skipping asks first, and only the second tap skips', async () => {
  live.encryption = status('unverified');
  const { user, onSkip } = setup();

  await press(user, /Skip for now/);
  expect(onSkip).not.toHaveBeenCalled();
  expect(await screen.findByText(/Skip confirming this device\?/)).toBeInTheDocument();

  await press(user, /Skip anyway/);
  await vi.waitFor(() => {
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

test('a reset needs the acknowledgement and hands its recovery key on', async () => {
  live.encryption = status('unverified', 'disabled');
  const { user, onReset } = setup();

  await press(user, /Reset my digital identity/);
  const reset = screen.getByRole('button', { name: /Reset my digital identity/ });
  expect(reset).toBeDisabled();

  await user.click(screen.getByRole('checkbox'));
  expect(reset).toBeEnabled();

  await user.click(reset);
  await vi.waitFor(() => {
    expect(onReset).toHaveBeenCalledWith('new key');
  });
});

test('a device confirmed while its reset is running still hands the new key on', async () => {
  live.encryption = status('unverified', 'disabled');
  let finish: (step: { step: 'done'; recovery_key: string }) => void = () => {};
  core.resetIdentity.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const { user, onReset, onComplete } = setup();

  await press(user, /Reset my digital identity/);
  await user.click(screen.getByRole('checkbox'));
  await press(user, /Reset my digital identity/);

  live.encryption = status('verified');
  flushSync();
  finish({ step: 'done', recovery_key: 'raced key' });

  await vi.waitFor(() => {
    expect(onReset).toHaveBeenCalledWith('raced key');
  });
  expect(onComplete).not.toHaveBeenCalled();
});
