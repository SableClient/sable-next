// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import type { InboxItemView, RoomListItemView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));
vi.mock('#lib/features/room/messages/event-items.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEventItems: () => ({ get: () => null, pending: () => false }),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import NotificationList from './NotificationList.svelte';

const roomList = new RoomList(core as unknown as CoreClient);
const inbox = vi.fn(() => Promise.resolve({ items: [] as InboxItemView[], has_more: false }));
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

test.each([
  ['on', null, 'public', true],
  ['off', null, 'invite', false],
  ['private', null, 'public', false],
  ['on', 'off', 'invite', false],
  ['off', 'on', 'public', true],
] as const)(
  "with media previews %s and the room's own %s, a custom emote in a %s room notification shows as an image: %s",
  async (level, roomLevel, joinRule, image) => {
    setPreference('mediaAutoLoad', level);
    onTestFinished(() => {
      setPreference('mediaAutoLoad', 'on');
      inbox.mockResolvedValue({ items: [], has_more: false });
    });
    roomList.rooms = [room('!a:example.org', { join_rule: joinRule, media_previews: roomLevel })];
    inbox.mockResolvedValue({
      items: [
        {
          room_id: '!a:example.org',
          event_id: '$e',
          ts: 1,
          sender: '@bob:example.org',
          sender_name: 'Bob',
          body: 'hi :blob:',
          emotes: [{ alt: ':blob:', source: 'mxc://example.org/blob' }],
          highlight: false,
          is_direct: false,
          encrypted: false,
          read: false,
          thread_root: null,
          reply: false,
        },
      ],
      has_more: false,
    });
    render(NotificationList, { filter: 'all', onFilter: vi.fn() });
    await settle();

    expect(document.querySelector('.preview')).not.toBeNull();
    expect(document.querySelector('.preview .preview-emote') !== null).toBe(image);
  }
);
