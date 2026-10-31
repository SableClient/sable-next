import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { withDmSpaceChildren } from './spaces';

function room(room_id: string, extra: Partial<RoomListItemView> = {}): RoomListItemView {
  return { room_id, room_kind: null, space_children: [], ...extra } as RoomListItemView;
}

const space = room('!space:a.org', { room_kind: 'space' });
const dm = room('!dm:b.org', { is_direct: true });

test('a privately linked DM becomes a child of its space', () => {
  const [linked] = withDmSpaceChildren([space, dm], new Map([['!dm:b.org', ['!space:a.org']]]));

  expect(linked.space_children).toEqual([
    { room_id: '!dm:b.org', via: ['b.org'], order: null, origin_server_ts: 0, suggested: false },
  ]);
});

test('a link to a DM that is not in the list, or one already listed, adds nothing', () => {
  const listed = room('!space:a.org', {
    room_kind: 'space',
    space_children: [
      { room_id: '!dm:b.org', via: ['b.org'], order: null, origin_server_ts: 5, suggested: false },
    ],
  });
  const links = new Map([
    ['!dm:b.org', ['!space:a.org']],
    ['!gone:b.org', ['!space:a.org']],
  ]);

  const [kept] = withDmSpaceChildren([listed, dm], links);

  expect(kept).toBe(listed);
});
