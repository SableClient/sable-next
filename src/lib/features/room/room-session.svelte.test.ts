import { expect, test, vi } from 'vitest';
import type {
  RoomOpenView,
  RoomPowerLevelsView,
  RoomStateEventView,
} from '#src/generated/protocol';
import { RoomSession } from './room-session.svelte.js';

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function opened(eventId: string): RoomOpenView {
  return {
    permissions: {
      own_power_level: 0,
      can_post: true,
      can_react: true,
      can_redact_own: true,
      can_redact_others: false,
      can_invite: true,
      can_kick: false,
      can_ban: false,
      can_change_settings: false,
      can_pin: false,
      can_change_join_rule: false,
      can_change_power_levels: false,
      can_manage_children: false,
    },
    power_level_tags: null,
    widgets: [],
    pinned_event_ids: [eventId],
    predecessor: null,
  };
}

function fixture() {
  const commands = {
    roomOpen: vi.fn(() => Promise.resolve(opened('$new'))),
    roomPowerLevels: vi.fn((): Promise<RoomPowerLevelsView> =>
      Promise.resolve({
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        events_default: 0,
        state_default: 50,
        users_default: 0,
        events: {},
        users: {},
        notifications_room: 50,
      })
    ),
    roomStateEvent: vi.fn((): Promise<unknown> => Promise.resolve(null)),
    roomStateEvents: vi.fn((): Promise<RoomStateEventView[]> => Promise.resolve([])),
    sendStateEvent: vi.fn(async () => {}),
  };
  const pins = { set: vi.fn() };
  return { commands, pins, session: new RoomSession(commands, pins) };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test('room changes discard stale details and pin updates', async () => {
  const { commands, pins, session } = fixture();
  const old = deferred<RoomOpenView>();
  commands.roomOpen.mockReturnValueOnce(old.promise);
  session.sync('!old', false, 0);
  session.sync('!new', false, 0);
  await settle();
  old.resolve(opened('$old'));
  await settle();
  expect(pins.set).toHaveBeenCalledExactlyOnceWith('!new', ['$new']);
  expect(session.permissions).toEqual(opened('$new').permissions);
  expect(session.powerLevels?.invite).toBe(0);
});

test('disposing a room discards its pending requests', async () => {
  const { commands, pins, session } = fixture();
  const request = deferred<RoomOpenView>();
  commands.roomOpen.mockReturnValueOnce(request.promise);
  session.sync('!room', false, 0);
  session.dispose();
  request.resolve(opened('$late'));
  await settle();
  expect(session.permissions).toBeNull();
  expect(session.powerLevels).toBeNull();
  expect(pins.set).not.toHaveBeenCalled();
});

test('widget removal cannot populate the next room with the previous room widgets', async () => {
  const { commands, session } = fixture();
  const widgets = deferred<RoomStateEventView[]>();
  commands.roomStateEvents.mockReturnValueOnce(widgets.promise);
  session.sync('!old', false, 0);
  await settle();
  const removal = session.details.removeWidget('widget');
  await settle();
  session.sync('!new', false, 0);
  await settle();
  widgets.resolve([
    {
      state_key: 'old',
      content: { type: 'm.custom', url: 'https://example.org/widget' },
    },
  ]);
  await removal;
  expect(commands.sendStateEvent).toHaveBeenCalledWith(
    '!old',
    'im.vector.modular.widgets',
    'widget',
    {}
  );
  expect(session.widgets).toEqual([]);
});

test('tombstone completion and member settings are cancelled on room change', async () => {
  const { commands, session } = fixture();
  const tombstone = deferred<unknown>();
  const listing = deferred<unknown>();
  commands.roomStateEvent
    .mockReturnValueOnce(listing.promise)
    .mockReturnValueOnce(tombstone.promise);
  session.sync('!old', true, 0);
  session.sync('!new', false, 1);
  tombstone.resolve({ replacement_room: '!replacement', body: 'old' });
  listing.resolve({});
  await settle();
  expect(session.tombstoneReplacementId).toBeNull();
  expect(session.tombstoneChecked).toBe(false);
  expect(session.alwaysListedFrom).toBeNull();
});

test('a member list revision keeps the current setting until the new one lands', async () => {
  const { commands, session } = fixture();
  commands.roomStateEvent.mockResolvedValueOnce({ always_listed_from: 50 });
  session.sync('!room', false, 0);
  await settle();
  expect(session.alwaysListedFrom).toBe(50);

  const next = deferred<unknown>();
  commands.roomStateEvent.mockReturnValueOnce(next.promise);
  session.sync('!room', false, 1);
  expect(session.alwaysListedFrom).toBe(50);

  next.resolve({ always_listed_from: 100 });
  await settle();
  expect(session.alwaysListedFrom).toBe(100);
});
