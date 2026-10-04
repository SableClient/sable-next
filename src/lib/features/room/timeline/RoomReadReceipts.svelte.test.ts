// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

import RoomReadReceipts from './RoomReadReceipts.svelte';

function member(user_id: string, display_name = user_id) {
  return {
    user_id,
    display_name,
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  };
}

test('opens the seen-by list from the overflow chip', async () => {
  const user = userEvent.setup();
  const readers = Array.from({ length: 5 }, (_, index) => `@user${String(index)}:example.org`);
  render(
    RoomReadReceipts,
    {
      readers,
      members: readers.map((id, index) => member(id, `User ${String(index)}`)),
      onMemberProfile: () => {},
    },
    { wrapper: TooltipProvider }
  );

  const overflow = screen.getByRole('button', { name: /Open the list/ });
  expect(overflow).toHaveTextContent('+2');

  await user.click(overflow);
  const list = await screen.findByRole('complementary');
  expect(within(list).getByText('User 0')).toBeInTheDocument();
  await user.click(within(list).getByRole('button', { name: 'Close read receipts' }));
});

test('hides when empty or not visible', () => {
  const { container, unmount } = render(
    RoomReadReceipts,
    { readers: [], members: [], onMemberProfile: () => {} },
    { wrapper: TooltipProvider }
  );
  expect(container.querySelector('.room-read-receipts')?.children).toHaveLength(0);
  unmount();

  const hidden = render(
    RoomReadReceipts,
    {
      readers: ['@bob:example.org'],
      members: [member('@bob:example.org', 'Bob')],
      visible: false,
      onMemberProfile: () => {},
    },
    { wrapper: TooltipProvider }
  );
  expect(hidden.container.querySelector('.room-read-receipts')?.children).toHaveLength(0);
});
