import { expect, test } from 'vitest';

import type { RoomPowerLevelsView } from '#src/generated/protocol';

import { canSendState, levelAt, permissionGroups } from './permission-groups';

const levels: RoomPowerLevelsView = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: {
    'im.vector.modular.widgets': 20,
    'm.reaction': 25,
    'm.room.name': 75,
    'm.room.tombstone': 100,
  },
  users: { '@admin:example.org': 100 },
  notifications_room: 50,
};

test('a listed event type answers with its own level', () => {
  expect(levelAt(levels, { kind: 'event', event_type: 'm.reaction' })).toBe(25);
  expect(levelAt(levels, { kind: 'state', event_type: 'm.room.name' })).toBe(75);
});

test('an absent type falls back to the default its kind uses', () => {
  expect(levelAt(levels, { kind: 'event', event_type: 'm.room.message' })).toBe(0);
  expect(levelAt(levels, { kind: 'state', event_type: 'm.room.topic' })).toBe(50);
});

test('state-event permission respects each explicit event override', () => {
  expect(canSendState(levels, 60, 'm.room.topic')).toBe(true);
  expect(canSendState(levels, 60, 'm.room.name')).toBe(false);
  expect(canSendState(levels, 60, 'm.room.tombstone')).toBe(false);
  expect(canSendState(levels, 60, 'im.vector.modular.widgets')).toBe(true);
});

test('actions and the room ping read their own fields', () => {
  expect(levelAt(levels, { kind: 'action', action: 'ban' })).toBe(50);
  expect(levelAt(levels, { kind: 'action', action: 'invite' })).toBe(0);
  expect(levelAt(levels, { kind: 'notification_room' })).toBe(50);
});

test('a space is offered space permissions, a room room ones', () => {
  const room = permissionGroups(false).flatMap((group) => group.items.map((item) => item.label));
  const space = permissionGroups(true).flatMap((group) => group.items.map((item) => item.label));

  expect(room).toContain('room.permSendMessages');
  expect(room).toContain('room.permEncryption');
  expect(space).toContain('room.permManageRooms');
  expect(space).not.toContain('room.permEncryption');
  expect(space).not.toContain('room.permHistoryVisibility');
});
