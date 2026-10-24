// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { RoomPermissionsView, RoomListItemView } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));

import { core } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import { FakeRuntime, roomsView } from '#lib/test-support/fake-runtime.js';
import { goto } from '#lib/test-support/app-navigation.js';
import { visit } from '#lib/test-support/app-state.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';
import InboxView from './InboxView.svelte';

const runtime = new FakeRuntime({ rooms: roomsView([]) });
const roomList = new RoomList(() => runtime.client());
const setRooms = (rooms: RoomListItemView[]) => {
  runtime.set('rooms', roomsView(rooms));
};

beforeAll(() => roomList.start());
afterAll(() => {
  roomList.stop();
});
const room = withCounts({
  room_id: '!room:example.org',
  name: 'Room',
  state: 'joined',
  join_rule: 'knock',
  unread: 0,
  notifying: 0,
  highlight: 0,
  marked_unread: false,
} as RoomListItemView);

Object.assign(core.rpc.members, {
  permissions: vi.fn(() =>
    Promise.resolve({
      can_invite: true,
      can_kick: true,
      own_power_level: 100,
    } as RoomPermissionsView)
  ),
  list: vi.fn(() =>
    Promise.resolve([
      {
        user_id: '@alice:example.org',
        display_name: 'Alice',
        power_level: 0,
        membership: 'knock',
      },
    ])
  ),
});
Object.assign(core.rpc.notifications, {
  inbox: vi.fn(() => Promise.resolve({ items: [], has_more: false })),
  backfillInbox: vi.fn(() => Promise.resolve({ recorded: 0, has_more: false })),
});
Object.assign(core.rpc.account, { inviteTriage: vi.fn(() => Promise.resolve([])) });

beforeEach(() => {
  goto.mockClear();
  visit('/inbox');
  setRooms([room]);
});

test('switches between notifications, invites and actionable join requests', async () => {
  render(InboxView);
  const user = userEvent.setup();
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await user.click(screen.getByRole('tab', { name: 'Invites' }));
  expect(await screen.findByText('No pending invitations.')).toBeInTheDocument();
  expect(goto).toHaveBeenLastCalledWith('/inbox?tab=invites', { replace: true, reset: false });

  await user.click(screen.getByRole('tab', { name: 'Requests' }));
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  expect(goto).toHaveBeenLastCalledWith('/inbox?tab=requests', { replace: true, reset: false });
});

test('opens the requests tab directly from its URL', async () => {
  visit('/inbox?tab=requests');
  render(InboxView);
  expect(screen.getByRole('tab', { name: 'Requests' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByText('Alice')).toBeInTheDocument();
});

test('keeps the notification filter while navigating tabs with the keyboard', async () => {
  visit('/inbox?filter=mentions');
  render(InboxView);
  const user = userEvent.setup();
  screen.getByRole('tab', { name: 'Notifications' }).focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Invites' })).toHaveFocus();
  expect(goto).toHaveBeenLastCalledWith('/inbox?filter=mentions&tab=invites', {
    replace: true,
    reset: false,
  });
});

test('shows the pending invite count on the invites tab', () => {
  setRooms([
    room,
    { ...room, room_id: '!a:example.org', state: 'invited' },
    { ...room, room_id: '!b:example.org', state: 'invited' },
  ]);
  render(InboxView);
  expect(screen.getByRole('tab', { name: /Invites/ })).toHaveTextContent('2');
});

test('lands on the invites tab when only invites are waiting', () => {
  setRooms([room, { ...room, room_id: '!a:example.org', state: 'invited' }]);
  render(InboxView);
  expect(screen.getByRole('tab', { name: /Invites/ })).toHaveAttribute('aria-selected', 'true');
});

test('lands on the invites tab ahead of notifications', () => {
  setRooms([
    withCounts({ ...room, unread: 1, notifying: 1, highlight: 1 }),
    { ...room, room_id: '!a:example.org', state: 'invited' },
  ]);
  render(InboxView);
  expect(screen.getByRole('tab', { name: /Invites/ })).toHaveAttribute('aria-selected', 'true');
});

test('keeps an explicit tab over pending invites', () => {
  visit('/inbox?tab=notifications');
  setRooms([room, { ...room, room_id: '!a:example.org', state: 'invited' }]);
  render(InboxView);
  expect(screen.getByRole('tab', { name: /Notifications/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
});

test('a room behind the badge with nothing in the feed still gets a row', async () => {
  runtime.set(
    'rooms',
    roomsView(
      [
        withCounts({
          ...room,
          is_direct: true,
          direct_targets: [],
          unread: 2,
          notifying: 2,
          notification: { room: null, default: 'all' },
        }),
      ],
      { badges: { [room.room_id]: { unread: 2, highlight: 0, marked: false, notifying: 2 } } }
    )
  );
  render(InboxView);
  const user = userEvent.setup();

  expect(await screen.findByText('2 unread notifications')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Mark Room as read' }));
  expect(core.rpc.timeline.markRead).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_id: null,
    private_receipt: false,
    thread_root: null,
    subscription: null,
    fully_read: false,
  });
});
