// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import type { RoomListItemView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));

import { core } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';
import NotificationList from './NotificationList.svelte';

const roomList = new RoomList(core as unknown as CoreClient);
const inbox = vi.fn(() => Promise.resolve({ items: [], has_more: false }));
Object.assign(core.rpc.notifications, {
  inbox,
  backfillInbox: vi.fn(() => Promise.resolve({ recorded: 0, has_more: false })),
});

function room(id: string, patch: Partial<RoomListItemView> = {}): RoomListItemView {
  return withCounts({
    room_id: id,
    name: id,
    state: 'joined',
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    ...patch,
  } as RoomListItemView);
}

async function settle(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  inbox.mockClear();
  roomList.rooms = [room('!a:example.org'), room('!b:example.org')];
});

test('does not reload the feed when the room list only reorders', async () => {
  render(NotificationList, { filter: 'all', onFilter: vi.fn() });
  await settle();
  const loads = inbox.mock.calls.length;

  roomList.rooms = [room('!b:example.org'), room('!a:example.org')];
  await settle();

  expect(inbox).toHaveBeenCalledTimes(loads);
});

test('reloads the feed when a room gains unread notifications', async () => {
  render(NotificationList, { filter: 'all', onFilter: vi.fn() });
  await settle();
  const loads = inbox.mock.calls.length;

  roomList.rooms = [room('!a:example.org', { unread: 1, notifying: 1 }), room('!b:example.org')];
  await settle();

  expect(inbox.mock.calls.length).toBeGreaterThan(loads);
});
