// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent, EncryptionStatusView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

let emit: (event: CoreEvent) => void = () => {};
const core = Object.assign(baseCore, {
  encryptionStatus: vi.fn<() => Promise<EncryptionStatusView>>(),
  subscribeEvents: vi.fn((handler: (event: CoreEvent) => void) => {
    emit = handler;
    return () => {};
  }),
});

import DeviceVerificationCard from './DeviceVerificationCard.svelte';

const status = (verification: EncryptionStatusView['verification']): EncryptionStatusView => ({
  verification,
  recovery: 'enabled',
  cross_signing_ready: true,
  recovery_passphrase: false,
});

function render() {
  const onComplete = vi.fn();
  const instance = mount(DeviceVerificationCard, {
    target: document.body,
    props: { onComplete, onSkip: vi.fn() },
  });
  return { instance, onComplete };
}

const recoveryField = () => document.querySelector('#login-recovery-key');

afterEach(() => {
  document.body.replaceChildren();
});

test('a device that is already verified skips the panel without showing it', async () => {
  core.encryptionStatus.mockResolvedValue(status('verified'));
  const { instance, onComplete } = render();

  await vi.waitFor(() => {
    expect(onComplete).toHaveBeenCalledOnce();
  });
  expect(recoveryField()).toBeNull();

  await unmount(instance);
});

test('an unknown state waits instead of prompting, then skips once verified', async () => {
  core.encryptionStatus.mockResolvedValue(status('unknown'));
  const { instance, onComplete } = render();
  await vi.waitFor(() => {
    expect(core.encryptionStatus).toHaveBeenCalled();
  });
  flushSync();

  expect(recoveryField()).toBeNull();
  expect(onComplete).not.toHaveBeenCalled();

  emit({ type: 'encryption_status', status: status('verified') });
  flushSync();

  expect(onComplete).toHaveBeenCalledOnce();
  expect(recoveryField()).toBeNull();

  await unmount(instance);
});

test('an unverified device is prompted and stays on the panel once verified', async () => {
  core.encryptionStatus.mockResolvedValue(status('unverified'));
  const { instance, onComplete } = render();

  await vi.waitFor(() => {
    expect(recoveryField()).not.toBeNull();
  });

  emit({ type: 'encryption_status', status: status('verified') });
  flushSync();

  expect(onComplete).not.toHaveBeenCalled();
  expect(recoveryField()).toBeNull();

  await unmount(instance);
});
