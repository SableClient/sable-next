// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import { core } from '#lib/core/__mocks__/context.js';
import { page, resetPage } from '#lib/test-support/app-state.js';
import RecoveryIncompleteBanner from './RecoveryIncompleteBanner.svelte';

function signedIn(backupUnlocked: boolean): void {
  Object.assign(core, {
    session: { user_id: '@me:example.org', device_id: 'NEW' },
    encryption: {
      verification: 'verified',
      recovery: 'incomplete',
      cross_signing_ready: false,
      backup_unlocked: backupUnlocked,
      signing_keys: { master: false, self_signing: false, user_signing: false },
      recovery_passphrase: false,
    },
  });
  page.route = { id: '/(app)/rooms' };
}

afterEach(() => {
  resetPage();
  localStorage.clear();
});

const title = () => screen.queryByText('This device cannot open your key backup');

test('asks for the recovery key while the backup is still locked', () => {
  signedIn(false);
  render(RecoveryIncompleteBanner);
  expect(title()).toBeInTheDocument();
});

test('stays away once the backup is unlocked, whatever other secret is missing', () => {
  signedIn(true);
  render(RecoveryIncompleteBanner);
  expect(title()).not.toBeInTheDocument();
});
