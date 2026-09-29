// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { EncryptionStatusView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  encryption: null as EncryptionStatusView | null,
  recoverIdentity: vi.fn<(key: string) => Promise<void>>(() => Promise.resolve()),
});

import SyncEncryption from './SyncEncryption.svelte';

function status(overrides: Partial<EncryptionStatusView>): EncryptionStatusView {
  return {
    verification: 'verified',
    recovery: 'enabled',
    cross_signing_ready: true,
    backup_unlocked: true,
    signing_keys: { master: true, self_signing: true, user_signing: true },
    recovery_passphrase: false,
    account_data_key: false,
    ...overrides,
  };
}

afterEach(() => {
  core.encryption = null;
  core.recoverIdentity.mockClear();
});

test('a device without the account data key unlocks it with the recovery key', async () => {
  core.encryption = status({});
  const user = userEvent.setup();
  render(SyncEncryption);

  await user.type(screen.getByLabelText('Use a recovery key'), ' EsT0 abcd ');
  await user.click(screen.getByRole('button', { name: 'Unlock' }));

  expect(core.recoverIdentity).toHaveBeenCalledWith('EsT0 abcd');
});

test('asks for nothing once the key is here, or while recovery is off', () => {
  core.encryption = status({ account_data_key: true });
  const { unmount } = render(SyncEncryption);

  expect(screen.getByText(/drafts are encrypted before they leave/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
  unmount();

  core.encryption = status({ recovery: 'disabled' });
  render(SyncEncryption);

  expect(screen.getByText(/Set up recovery to encrypt/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
});
