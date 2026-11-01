// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import RoomChecklist from './RoomChecklist.svelte';

function room(roomId: string, alias: string | null): RoomListItemView {
  return {
    room_id: roomId,
    name: 'General',
    canonical_alias: alias,
    avatar_url: null,
  } as RoomListItemView;
}

test('rooms with the same name are told apart by their address', () => {
  render(RoomChecklist, {
    class: 'targets',
    rooms: [room('!a:one.org', '#general:one.org'), room('!b:two.org', null)],
    selected: [],
    label: (item: RoomListItemView) => item.name ?? item.room_id,
  });

  const [aliased, plain] = screen.getAllByRole('checkbox');
  expect(aliased.querySelector('.alias')).toHaveTextContent('#general:one.org');
  expect(plain.querySelector('.alias')).toBeNull();
});
