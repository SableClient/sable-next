import { expect, test } from 'vitest';

import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';

import { levelAt, permissionGroups, toEventContent, withLevel } from './permission-groups';

const levels: RoomPowerLevelsView = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: { 'm.reaction': 25, 'm.room.name': 75 },
  users: { '@admin:example.org': 100 },
  notifications_room: 50,
};

test('a listed event type answers with its own level', () => {
  expect(levelAt(levels, { kind: 'event', eventType: 'm.reaction' })).toBe(25);
  expect(levelAt(levels, { kind: 'state', eventType: 'm.room.name' })).toBe(75);
});

test('an absent type falls back to the default its kind uses', () => {
  expect(levelAt(levels, { kind: 'event', eventType: 'm.room.message' })).toBe(0);
  expect(levelAt(levels, { kind: 'state', eventType: 'm.room.topic' })).toBe(50);
});

test('actions and the room ping read their own fields', () => {
  expect(levelAt(levels, { kind: 'action', action: 'ban' })).toBe(50);
  expect(levelAt(levels, { kind: 'action', action: 'invite' })).toBe(0);
  expect(levelAt(levels, { kind: 'notification-room' })).toBe(50);
});

test('setting a level leaves the original untouched', () => {
  const next = withLevel(levels, { kind: 'state', eventType: 'm.room.topic' }, 100);

  expect(next.events['m.room.topic']).toBe(100);
  expect(levels.events['m.room.topic']).toBeUndefined();
  expect(next.events['m.reaction']).toBe(25);
  expect(next.users).toEqual(levels.users);
});

test('setting an action or default writes the field, not the event map', () => {
  expect(withLevel(levels, { kind: 'action', action: 'kick' }, 0).kick).toBe(0);
  expect(withLevel(levels, { kind: 'events-default' }, 10).events_default).toBe(10);
  expect(withLevel(levels, { kind: 'state-default' }, 10).state_default).toBe(10);
  expect(withLevel(levels, { kind: 'notification-room' }, 0).notifications_room).toBe(0);
});

test('the event content carries every field the room needs', () => {
  expect(toEventContent(levels)).toEqual({
    ban: 50,
    kick: 50,
    redact: 50,
    invite: 0,
    events_default: 0,
    state_default: 50,
    users_default: 0,
    events: { 'm.reaction': 25, 'm.room.name': 75 },
    users: { '@admin:example.org': 100 },
    notifications: { room: 50 },
  });
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
