// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SignOutSafetyView } from '#src/generated/protocol';

vi.hoisted(() => ({}));

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { goto } from '#lib/test-support/app-navigation.js';
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  afterOverlayPops: () => Promise.resolve(),
  holdOverlayBack: () => {},
}));

import { SignOutGuard } from './sign-out-guard.svelte.js';
import SignOutWarningDialog from './SignOutWarningDialog.svelte';

const safe: SignOutSafetyView = {
  encryption: {
    verification: 'verified',
    recovery: 'enabled',
    cross_signing_ready: true,
    backup_unlocked: true,
    signing_keys: { master: true, self_signing: true, user_signing: true },
    recovery_passphrase: false,
    account_data_key: false,
  },
  backup_enabled: true,
  backup_uploaded: true,
  has_encrypted_rooms: true,
};

afterEach(() => {});

async function openWarning(safety: SignOutSafetyView) {
  const guard = new SignOutGuard({
    commands: { signOutSafety: () => Promise.resolve(safety) },
  } as unknown as CoreClient);
  const proceed = vi.fn(() => Promise.resolve());
  render(SignOutWarningDialog, { guard });
  await guard.request(proceed);
  await tick();
  return { user: userEvent.setup(), guard, proceed };
}

const button = (name: string) => screen.queryByRole('button', { name });

test('stays closed when the sign-out is safe', async () => {
  const { proceed } = await openWarning(safe);

  expect(proceed).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('explains the risk and signs out only when asked to', async () => {
  const { user, proceed } = await openWarning({
    ...safe,
    encryption: { ...safe.encryption, recovery: 'disabled' },
  });

  expect(await screen.findByRole('dialog')).toHaveTextContent('Recovery is not set up.');
  expect(proceed).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Log out anyway' }));
  await vi.waitFor(() => {
    expect(proceed).toHaveBeenCalledOnce();
  });
});

test('routes an unverified session to the security settings instead', async () => {
  const { user, guard, proceed } = await openWarning({
    ...safe,
    encryption: { ...safe.encryption, verification: 'unverified' },
  });

  await user.click(await screen.findByRole('button', { name: 'Verify this session' }));
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith('/settings/devices');
  });
  expect(guard.risk).toBeNull();
  expect(proceed).not.toHaveBeenCalled();
});

test('offers only the export while keys are still uploading', async () => {
  await openWarning({ ...safe, backup_uploaded: false });

  expect(await screen.findByRole('button', { name: 'Export keys' })).toBeInTheDocument();
  expect(button('Set up recovery')).not.toBeInTheDocument();
  expect(button('Verify this session')).not.toBeInTheDocument();
});
