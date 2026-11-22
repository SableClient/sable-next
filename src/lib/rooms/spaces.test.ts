import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { roomSpaces } from '#lib/model/model.js';
import { roomView } from '#lib/test-support/room-views.js';

import { ancestorSpaceIds, inheritedNotificationModes, spacesContaining } from './spaces';

function room(overrides: Partial<RoomListItemView>): RoomListItemView {
  return roomView({
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    ...overrides,
  });
}

function child(roomId: string) {
  return {
    room_id: roomId,
    via: [],
    order: null,
    origin_server_ts: 1,
    suggested: false,
    private: false,
  };
}

function lookup(rooms: readonly RoomListItemView[]) {
  const byId = new Map(roomSpaces(rooms).map((entry) => [entry.room_id, entry]));
  return (roomId: string) => byId.get(roomId);
}

test('ancestors come farthest first and stop on a cycle', () => {
  const rooms = [
    room({ room_id: '!root', room_kind: 'space', space_children: [child('!mid')] }),
    room({ room_id: '!mid', room_kind: 'space', space_children: [child('!room'), child('!root')] }),
    room({ room_id: '!room' }),
  ];
  expect(ancestorSpaceIds(lookup(rooms)('!room'))).toEqual(['!root', '!mid']);
  expect(ancestorSpaceIds(undefined)).toEqual([]);
});

test('a room takes the mode of its nearest space that sets one', () => {
  const root = room({
    room_id: '!root:example.org',
    room_kind: 'space',
    space_children: [child('!sub:example.org'), child('!top:example.org')],
  });
  const sub = room({
    room_id: '!sub:example.org',
    room_kind: 'space',
    space_children: [child('!deep:example.org'), child('!root:example.org')],
  });
  const other = room({
    room_id: '!other:example.org',
    room_kind: 'space',
    space_children: [child('!top:example.org'), child('!invited:example.org')],
  });
  const rooms = [
    root,
    sub,
    other,
    room({ room_id: '!top:example.org' }),
    room({ room_id: '!deep:example.org' }),
    room({ room_id: '!invited:example.org', state: 'invited' }),
  ];

  expect(
    inheritedNotificationModes(
      lookup(rooms),
      new Map([
        ['!root:example.org', 'mute'],
        ['!sub:example.org', 'all'],
        ['!other:example.org', 'mentions'],
      ])
    )
  ).toEqual(
    new Map([
      ['!root:example.org', 'mute'],
      ['!sub:example.org', 'all'],
      ['!other:example.org', 'mentions'],
      ['!top:example.org', 'mute'],
      ['!deep:example.org', 'all'],
    ])
  );
  expect(
    inheritedNotificationModes(lookup(rooms), new Map([['!root:example.org', 'mute']]))
  ).toEqual(
    new Map([
      ['!root:example.org', 'mute'],
      ['!sub:example.org', 'mute'],
      ['!top:example.org', 'mute'],
      ['!deep:example.org', 'mute'],
    ])
  );
});

test('a space shows voice activity from any joined room under it', () => {
  const caller = { user_id: '@ada:example.org', device_id: 'D', member_id: 'm' } as never;
  const root = room({
    room_id: '!root:example.org',
    room_kind: 'space',
    space_children: [child('!sub:example.org')],
  });
  const sub = room({
    room_id: '!sub:example.org',
    room_kind: 'space',
    space_children: [child('!voice:example.org'), child('!left:example.org')],
  });
  const quiet = room({
    room_id: '!quiet:example.org',
    room_kind: 'space',
    space_children: [child('!left:example.org')],
  });
  const voice = room({ room_id: '!voice:example.org', call_participants: [caller] });
  const left = room({ room_id: '!left:example.org', state: 'left', call_participants: [caller] });
  const live = (candidate: typeof voice) =>
    candidate.state === 'joined' && candidate.call_participants.length > 0;

  expect(
    spacesContaining(
      [root, quiet],
      [root, sub, quiet, voice, left],
      lookup([root, sub, quiet, voice, left]),
      live
    )
  ).toEqual(new Set(['!root:example.org']));
});
