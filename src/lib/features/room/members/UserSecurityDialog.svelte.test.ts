// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import UserSecurityDialog from './UserSecurityDialog.svelte';

const userSecurity = vi.fn(() =>
  Promise.resolve({
    verification: 'unverified' as const,
    verification_violation: false,
    devices: [
      {
        device_id: 'SIGNED',
        display_name: 'Alice phone',
        verified: false,
        cross_signed: true,
        blocked: false,
      },
      {
        device_id: 'UNSIGNED',
        display_name: null,
        verified: false,
        cross_signed: false,
        blocked: true,
      },
    ],
  })
);
const requestVerification = vi.fn(() => Promise.resolve('flow'));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(core, { userSecurity, requestVerification });
});

test('shows identity and MSC4153 device eligibility, then starts user verification', async () => {
  render(UserSecurityDialog, {
    props: {
      open: true,
      userId: '@alice:example.org',
      displayName: 'Alice',
      onOpenChange: vi.fn(),
    },
  });

  expect(await screen.findByRole('heading', { name: 'Encryption for Alice' })).toBeInTheDocument();
  expect(screen.getByText('Alice phone')).toBeInTheDocument();
  expect(screen.getByText('Not signed by owner')).toBeInTheDocument();
  expect(screen.getByText('Blocked')).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Verify identity' }));
  expect(requestVerification).toHaveBeenCalledWith('@alice:example.org');
});
