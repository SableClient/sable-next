// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';

import { withCounts } from '#lib/rooms/summary-fixtures.js';
import { NO_UNREAD } from '#lib/rooms/unread.js';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => ({
    rooms,
    badgeUnreadFor: (room: { room_id: string }) =>
      room.room_id === '!loud:example.org' ? { unread: 2, highlight: 0, marked: false } : NO_UNREAD,
  }),
}));

import RoomJumpList from './RoomJumpList.svelte';

const rooms = ['Quiet', 'Loud'].map((name) =>
  withCounts({
    room_id: `!${name.toLowerCase()}:example.org`,
    name,
    canonical_alias: null,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    group_members: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_tombstoned: false,
    call_participants: [],
    screen_sharers: [],
    room_kind: 'text',
    supports_knock: false,
    supports_restricted: false,
    supports_knock_restricted: false,
    can_manage_children: false,
    space_children: [],
    bridge: null,
    media_previews: null,
    unread: 2,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
  })
);

test('a room whose unread dot the room list hides shows no dot in the jump list', () => {
  render(RoomJumpList, { onSelect: () => {} });

  const quiet = screen.getByRole('option', { name: /Quiet/ });
  const loud = screen.getByRole('option', { name: /Loud/ });
  expect(quiet.querySelector('.unread-badge')).toBeNull();
  expect(loud.querySelector('.unread-badge')).not.toBeNull();
});

function press(target: Element, key: string, keyCode: number): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  target.dispatchEvent(event);
}

test('keys that drive an IME composition neither move the selection nor open a room', async () => {
  const onSelect = vi.fn();
  render(RoomJumpList, { onSelect });
  const input = screen.getByRole('combobox');
  const first = input.getAttribute('aria-activedescendant');

  press(input, 'ArrowDown', 229);
  await tick();
  expect(input.getAttribute('aria-activedescendant')).toBe(first);
  press(input, 'Enter', 229);
  expect(onSelect).not.toHaveBeenCalled();

  press(input, 'Enter', 13);
  expect(onSelect).toHaveBeenCalledOnce();
});
