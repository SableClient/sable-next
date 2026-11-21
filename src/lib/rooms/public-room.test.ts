import { expect, test } from 'vitest';
import type { RoomJoinRuleView, RoomListItemView } from '#src/generated/protocol';

import { isPublicRoom } from './public-room';

function room(
  roomId: string,
  joinRule: RoomJoinRuleView,
  children: string[] = []
): RoomListItemView {
  return {
    room_id: roomId,
    join_rule: joinRule,
    space_children: children.map((child) => ({ room_id: child })),
  } as RoomListItemView;
}

test('a public room is public', () => {
  expect(isPublicRoom(room('!a:x', 'public'), [])).toBe(true);
});

test('a restricted room is public when a public space holds it', () => {
  const child = room('!a:x', 'restricted');
  expect(isPublicRoom(child, [room('!s:x', 'public', ['!a:x']), child])).toBe(true);
  expect(isPublicRoom(room('!a:x', 'knock_restricted'), [room('!s:x', 'public', ['!a:x'])])).toBe(
    true
  );
});

test('a restricted room in a private space is not public', () => {
  expect(isPublicRoom(room('!a:x', 'restricted'), [room('!s:x', 'invite', ['!a:x'])])).toBe(false);
  expect(isPublicRoom(room('!a:x', 'restricted'), [])).toBe(false);
});

test('invite and knock rooms are not public', () => {
  const spaces = [room('!s:x', 'public', ['!a:x'])];
  expect(isPublicRoom(room('!a:x', 'invite'), spaces)).toBe(false);
  expect(isPublicRoom(room('!a:x', 'knock'), spaces)).toBe(false);
});
