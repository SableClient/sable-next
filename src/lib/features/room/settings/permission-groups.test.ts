import { expect, test } from 'vitest';

import type { RoomPowerLevelsView } from '#src/generated/protocol';

import {
  canSendState,
  levelAt,
  permissionGroups,
  syncedFromSpace,
  toEventContent,
  withLevel,
} from './permission-groups';

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
  expect(levelAt(levels, { kind: 'event', eventType: 'm.reaction' })).toBe(25);
  expect(levelAt(levels, { kind: 'state', eventType: 'm.room.name' })).toBe(75);
});

test('an absent type falls back to the default its kind uses', () => {
  expect(levelAt(levels, { kind: 'event', eventType: 'm.room.message' })).toBe(0);
  expect(levelAt(levels, { kind: 'state', eventType: 'm.room.topic' })).toBe(50);
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
    events: {
      'im.vector.modular.widgets': 20,
      'm.reaction': 25,
      'm.room.name': 75,
      'm.room.tombstone': 100,
    },
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

const space: RoomPowerLevelsView = {
  ban: 75,
  kick: 75,
  redact: 50,
  invite: 50,
  events_default: 100,
  state_default: 100,
  users_default: 0,
  events: { 'm.space.child': 50, 'm.room.name': 50 },
  users: { '@admin:example.org': 100, '@mod:example.org': 50 },
  notifications_room: 50,
};

test('a sync takes the space levels a room shares with it', () => {
  const next = syncedFromSpace(levels, space, '@admin:example.org', 100);

  expect(next.ban).toBe(75);
  expect(next.kick).toBe(75);
  expect(next.invite).toBe(50);
  expect(next.state_default).toBe(100);
  expect(next.events['m.room.name']).toBe(50);
  expect(next.users['@mod:example.org']).toBe(50);
});

test('a sync keeps what only a room has, or only a space means', () => {
  const next = syncedFromSpace(levels, space, '@admin:example.org', 100);

  expect(next.events_default).toBe(0);
  expect(next.events['m.reaction']).toBe(25);
  expect(next.events['im.vector.modular.widgets']).toBe(20);
  expect(next.events['m.space.child']).toBeUndefined();
  expect(next.events['m.room.redaction']).toBeUndefined();
});

test('a sync applies the space default before the types that fall back to it', () => {
  const next = syncedFromSpace(
    { ...levels, events: {} },
    { ...space, events: { 'm.room.topic': 50 } },
    '@admin:example.org',
    100
  );

  expect(levelAt(next, { kind: 'state', eventType: 'm.room.topic' })).toBe(50);
  expect(levelAt(next, { kind: 'state', eventType: 'm.room.avatar' })).toBe(100);
});

test('a sync removes members the space does not list', () => {
  const next = syncedFromSpace(
    { ...levels, users: { '@admin:example.org': 100, '@bot:example.org': 50 } },
    space,
    '@admin:example.org',
    100
  );

  expect(next.users).toEqual({ '@admin:example.org': 100, '@mod:example.org': 50 });
});

test('a sync leaves everything the server would refuse to change', () => {
  const next = syncedFromSpace(
    { ...levels, users: { '@self:example.org': 50, '@peer:example.org': 50 } },
    { ...space, users: { '@self:example.org': 0, '@new:example.org': 100 } },
    '@self:example.org',
    50
  );

  expect(next.users).toEqual({ '@self:example.org': 50, '@peer:example.org': 50 });
  expect(next.ban).toBe(50);
  expect(next.state_default).toBe(50);
  expect(next.redact).toBe(50);
  expect(next.invite).toBe(50);
});
