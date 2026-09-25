import { expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';

import { createCoreStub } from './__mocks__/context';
import { IdentityReset } from './identity-reset.svelte';

function resetWith(overrides: Record<string, unknown>) {
  const core = createCoreStub(overrides);
  return new IdentityReset(core as unknown as CoreClient);
}

test('a reset the server lets through shows the new key', async () => {
  const reset = resetWith({
    resetIdentity: () => Promise.resolve({ step: 'done', recovery_key: 'EsTn ew' }),
  });

  await reset.start();

  expect(reset.phase).toBe('done');
  expect(reset.recoveryKey).toBe('EsTn ew');
});

test('a wrong password keeps the prompt and a right one finishes', async () => {
  const continueIdentityReset = vi
    .fn()
    .mockRejectedValueOnce(new CoreError({ code: 'denied' }))
    .mockResolvedValueOnce('EsTn ew');
  const reset = resetWith({
    resetIdentity: () => Promise.resolve({ step: 'password' }),
    continueIdentityReset,
  });

  await reset.start();
  reset.password = 'wrong';
  await reset.submitPassword();

  expect(reset.phase).toBe('password');
  expect(reset.error).toBe(t('settings.wrongPassword'));

  reset.password = 'hunter2';
  await reset.submitPassword();

  expect(continueIdentityReset).toHaveBeenLastCalledWith('hunter2');
  expect(reset.phase).toBe('done');
  expect(reset.recoveryKey).toBe('EsTn ew');
  expect(reset.password).toBe('');
});

test('cancelling a pending approval tells the core and ignores the late answer', async () => {
  let answer: (key: string) => void = () => {};
  const cancelIdentityReset = vi.fn(() => Promise.resolve());
  const reset = resetWith({
    resetIdentity: () => Promise.resolve({ step: 'approve', url: 'https://auth.example/approve' }),
    continueIdentityReset: () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    cancelIdentityReset,
  });

  await reset.start();
  expect(reset.approvalUrl).toBe('https://auth.example/approve');
  const waiting = reset.awaitApproval();
  await reset.cancel();
  answer('EsTn ew');
  await waiting;

  expect(cancelIdentityReset).toHaveBeenCalledOnce();
  expect(reset.phase).toBe('confirm');
  expect(reset.recoveryKey).toBeNull();
});
