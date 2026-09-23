import { expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';

import { createCoreStub } from './__mocks__/context';
import { DeviceVerification } from './device-verification.svelte';

function verificationWith(overrides: Record<string, unknown>) {
  const core = createCoreStub(overrides);
  return { core, verification: new DeviceVerification(core as unknown as CoreClient) };
}

test('a recovered identity clears the key and continues', async () => {
  const recoverIdentity = vi.fn(() => Promise.resolve());
  const { verification } = verificationWith({ recoverIdentity });
  const onRecovered = vi.fn();
  verification.recoveryKey = '  EsTc abcd  ';

  await verification.recoverIdentity(onRecovered);

  expect(recoverIdentity).toHaveBeenCalledWith('EsTc abcd');
  expect(verification.recoveryKey).toBe('');
  expect(verification.recovering).toBe(false);
  expect(onRecovered).toHaveBeenCalledOnce();
});

test('a denied recovery key reads as an invalid key and keeps what was typed', async () => {
  const { verification } = verificationWith({
    recoverIdentity: () => Promise.reject(new CoreError({ code: 'denied' })),
  });
  const onRecovered = vi.fn();
  verification.recoveryKey = 'wrong';

  await verification.recoverIdentity(onRecovered);

  expect(verification.error).toBe(t('settings.invalidRecoveryKey'));
  expect(verification.recoveryKey).toBe('wrong');
  expect(onRecovered).not.toHaveBeenCalled();
});

test('a request is sent for the signed-in user and continues', async () => {
  const requestVerification = vi.fn(() => Promise.resolve('flow'));
  const { verification } = verificationWith({
    session: { user_id: '@me:example.org' },
    requestVerification,
  });
  const onRequested = vi.fn();

  await verification.requestVerification(onRequested);

  expect(requestVerification).toHaveBeenCalledWith('@me:example.org');
  expect(verification.requesting).toBe(false);
  expect(onRequested).toHaveBeenCalledOnce();
});

test('nothing is requested without a session', async () => {
  const requestVerification = vi.fn();
  const { verification } = verificationWith({ requestVerification });

  await verification.requestVerification();

  expect(requestVerification).not.toHaveBeenCalled();
});
