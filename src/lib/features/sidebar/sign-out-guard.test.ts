import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SignOutSafetyView } from '#src/generated/protocol';

import { SignOutGuard, signOutRisk } from './sign-out-guard.svelte.js';

const safe: SignOutSafetyView = {
  encryption: { verification: 'verified', recovery: 'enabled', cross_signing_ready: true },
  backup_enabled: true,
  backup_uploaded: true,
  has_encrypted_rooms: true,
};

function guardFor(signOutSafety: () => Promise<SignOutSafetyView>): SignOutGuard {
  return new SignOutGuard({ commands: { signOutSafety } } as unknown as CoreClient);
}

test.each([
  ['a verified session with recovery and an uploaded backup', safe, null],
  [
    'an account without encrypted rooms',
    {
      ...safe,
      encryption: { ...safe.encryption, verification: 'unverified', recovery: 'disabled' },
      backup_enabled: false,
      has_encrypted_rooms: false,
    },
    null,
  ],
  [
    'an unverified session',
    { ...safe, encryption: { ...safe.encryption, verification: 'unverified' } },
    'unverified',
  ],
  [
    'an unknown verification state',
    { ...safe, encryption: { ...safe.encryption, verification: 'unknown' } },
    'unverified',
  ],
  [
    'recovery that was never set up',
    { ...safe, encryption: { ...safe.encryption, recovery: 'disabled' } },
    'no_recovery',
  ],
  [
    'recovery missing secrets on this device',
    { ...safe, encryption: { ...safe.encryption, recovery: 'incomplete' } },
    'no_recovery',
  ],
  ['a disabled key backup', { ...safe, backup_enabled: false }, 'no_backup'],
  ['keys still waiting to upload', { ...safe, backup_uploaded: false }, 'backup_pending'],
] satisfies [string, SignOutSafetyView, ReturnType<typeof signOutRisk>][])(
  'decides the risk of %s',
  (_label, safety, risk) => {
    expect(signOutRisk(safety)).toBe(risk);
  }
);

test('signs out at once when nothing is at risk', async () => {
  const guard = guardFor(() => Promise.resolve(safe));
  const proceed = vi.fn(() => Promise.resolve());

  await guard.request(proceed);

  expect(proceed).toHaveBeenCalledOnce();
  expect(guard.risk).toBeNull();
});

test('holds the sign-out until it is confirmed', async () => {
  const guard = guardFor(() => Promise.resolve({ ...safe, backup_enabled: false }));
  const proceed = vi.fn(() => Promise.resolve());

  await guard.request(proceed);
  expect(guard.risk).toBe('no_backup');
  expect(proceed).not.toHaveBeenCalled();

  await guard.confirm();
  expect(proceed).toHaveBeenCalledOnce();
  expect(guard.risk).toBeNull();
});

test('warns when the core cannot answer', async () => {
  const guard = guardFor(() => Promise.reject(new Error('offline')));
  const proceed = vi.fn(() => Promise.resolve());

  await guard.request(proceed);

  expect(guard.risk).toBe('unknown');
  expect(proceed).not.toHaveBeenCalled();
});

test('a dismissed warning never signs out', async () => {
  const guard = guardFor(() => Promise.resolve({ ...safe, backup_uploaded: false }));
  const proceed = vi.fn(() => Promise.resolve());

  await guard.request(proceed);
  guard.dismiss();
  await guard.confirm();

  expect(proceed).not.toHaveBeenCalled();
  expect(guard.risk).toBeNull();
});
