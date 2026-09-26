// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null }) };
});

import RoomReadReceipts from './RoomReadReceipts.svelte';

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

test('shows a face stack and opens the seen-by list', async () => {
  const user = userEvent.setup();
  render(RoomReadReceipts, {
    readers: ['@bob:example.org', '@carol:example.org'],
    members,
    onMemberProfile: () => {},
  });

  const trigger = screen.getByRole('button', { name: 'Seen by Bob, Carol. Open the list.' });
  expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveAttribute('title', 'Bob, Carol');
  expect(trigger.querySelectorAll('.avatar-root')).toHaveLength(2);
  expect(trigger.querySelector('.overflow')).not.toBeInTheDocument();

  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const list = await screen.findByRole('complementary');
  expect(within(list).getByText('Bob')).toBeInTheDocument();
  expect(within(list).getByText('Carol')).toBeInTheDocument();
  await user.click(within(list).getByRole('button', { name: 'Close read receipts' }));
});

test('caps the stack at three faces and keeps the row reserved when empty', () => {
  const many = Array.from({ length: 12 }, (_, index) => `@user${String(index)}:example.org`);
  const instance = render(RoomReadReceipts, {
    readers: many,
    members: many.map((user_id) => ({
      user_id,
      display_name: user_id,
      avatar_url: null,
      power_level: 0,
      membership: 'join' as const,
      member_ts: null,
      kicked: false,
      service: false,
    })),
    onMemberProfile: () => {},
  });

  const trigger = screen.getByRole('button');
  expect(trigger.querySelectorAll('.stack .avatar-root')).toHaveLength(3);
  expect(trigger).toHaveTextContent('+9');

  instance.unmount();

  const { container } = render(RoomReadReceipts, {
    readers: [],
    members: [],
    onMemberProfile: () => {},
  });

  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(container.querySelector('.room-read-receipts')?.children).toHaveLength(0);
});

test('hides the trigger when not visible but keeps the row reserved', () => {
  const { container } = render(RoomReadReceipts, {
    readers: ['@bob:example.org'],
    members,
    visible: false,
    onMemberProfile: () => {},
  });

  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(container.querySelector('.room-read-receipts')?.children).toHaveLength(0);
});
