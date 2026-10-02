// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { RoomPermissionsView, RoomSummary } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));

import { core } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import { goto } from '#lib/test-support/app-navigation.js';
import { visit } from '#lib/test-support/app-state.js';
import InboxView from './InboxView.svelte';

const roomList = new RoomList(core as unknown as CoreClient);
const room = {
  room_id: '!room:example.org',
  name: 'Room',
  state: 'joined',
  join_rule: 'knock',
  unread: 0,
  notifying: 0,
  highlight: 0,
} as RoomSummary;

Object.assign(core, {
  inboxNotifications: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
  backfillInbox: vi.fn(() => Promise.resolve({ hasMore: false })),
  roomPermissions: vi.fn(() =>
    Promise.resolve({
      can_invite: true,
      can_kick: true,
      own_power_level: 100,
    } as RoomPermissionsView)
  ),
  roomMembers: vi.fn(() =>
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

beforeEach(() => {
  goto.mockClear();
  visit('/inbox');
  roomList.rooms = [room];
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
