// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null }) };
});

import MemberUserList from './MemberUserList.svelte';

const members = [
  {
    user_id: '@bob:example.org',
    display_name: 'Bob',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
  {
    user_id: '@carol:example.org',
    display_name: 'Carol',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
];

test('renders readers in order and closes from the header', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(MemberUserList, {
    title: 'Seen by',
    userIds: ['@bob:example.org', '@carol:example.org'],
    members,
    onMemberProfile: vi.fn(),
    onClose,
  });

  const names = screen.getAllByText(/^(Bob|Carol)$/).map((name) => name.textContent);
  expect(names).toEqual(['Bob', 'Carol']);
  await user.click(screen.getByRole('button', { name: 'Close members' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
