import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { NotificationModeView, RoomSummary } from '#src/generated/protocol';

import { roomNotifications, roomUnread } from '#lib/rooms/unread.js';

const roomsFixture = vi.hoisted(() => {
  const fixture = {
    rooms: [] as RoomSummary[],
    typingUsers: new Map<string, readonly string[]>(),
    warm: () => {},
    byId: (roomId: string | null) => fixture.rooms.find((room) => room.room_id === roomId),
    notificationOverride: () => null,
    notificationMode: (): NotificationModeView => 'all',
    mutedRoomIds: new Set<string>(),
    quietRoomIds: new Set<string>(),
    unreadFor: (room: RoomSummary) => roomUnread(room, 'all'),
    badgeUnreadFor: (room: RoomSummary) => roomUnread(room, 'all'),
    notificationsFor: (room: RoomSummary) => roomNotifications(room, 'all'),
  };
  return fixture;
});

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => roomsFixture,
  roomLabel: (room: RoomSummary) => room.name ?? room.canonical_alias ?? room.room_id,
  roomAvatarUrl: (room: RoomSummary) => room.avatar_url,
}));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { core } from '#lib/core/__mocks__/context.js';

import RoomNavHarness from './RoomNavHarness.test.svelte';

afterEach(async () => {
  roomsFixture.rooms = [];
  await page.viewport(414, 800);
});

function room(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    room_id: '!room:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: false,
    is_tombstoned: false,
    is_voice: false,
    call_participants: [],
    screen_sharers: [],
    room_type: null,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: { sender: null, body: 'hi', timestamp: 1, sending: false, event_id: null },
    ...overrides,
  };
}

async function mountNav(props: { collapsed?: boolean; width?: number } = {}) {
  Object.assign(core, {
    notificationSettings: vi.fn().mockResolvedValue({ mode: 'all', default: 'all' }),
  });
  await page.viewport(1280, 900);
  return render(RoomNavHarness, props);
}

test('collapsed room rows keep their unread badges inside the row', async () => {
  roomsFixture.rooms = [
    room({ room_id: '!a:example.org', name: 'General', unread: 4, notifying: 4, highlight: 1 }),
    room({ room_id: '!b:example.org', name: 'Random', unread: 12, notifying: 12 }),
    room({ room_id: '!c:example.org', name: 'Elsewhere', unread: 120, notifying: 120 }),
  ];
  await mountNav({ collapsed: true, width: 50 });

  await expect
    .poll(() => document.querySelectorAll('.room-list.collapsed .room-row .unread-badge').length)
    .toBeGreaterThan(0);
  const outside = [
    ...document.querySelectorAll('.room-list.collapsed .room-row .unread-badge'),
  ].filter((badge) => {
    const wrap = badge.closest('.room-row-wrap')?.getBoundingClientRect();
    const box = badge.getBoundingClientRect();
    return !wrap || box.left < wrap.left || box.right > wrap.right || box.top < wrap.top;
  });
  expect(outside).toHaveLength(0);
});

test('the row options button toggles the shared menu and returns focus', async () => {
  roomsFixture.rooms = [room({ room_id: '!a:example.org', name: 'General' })];
  const screen = await mountNav();
  const wrap = () => {
    const node = [...document.querySelectorAll<HTMLElement>('.room-row-wrap')].find((candidate) =>
      candidate.textContent.includes('General')
    );
    if (!node) throw new Error('the General row is not rendered');
    return node;
  };
  await expect.poll(() => document.querySelector('.room-row-wrap')).not.toBeNull();
  await userEvent.hover(wrap());
  const trigger = screen.getByRole('button', { name: 'Room options' });

  await userEvent.click(trigger);
  await expect.element(screen.getByRole('menu')).toBeVisible();
  await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');

  await userEvent.click(trigger);
  await expect.poll(() => screen.getByRole('menu').elements().length).toBe(0);
  for (let frame = 0; frame < 20; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  expect(screen.getByRole('menu').elements()).toHaveLength(0);

  trigger.element().focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('menu')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => screen.getByRole('menu').elements().length).toBe(0);
  await expect.element(trigger).toHaveFocus();

  await userEvent.click(screen.getByText('General'), { button: 'right' });
  await expect.element(screen.getByRole('menu')).toBeVisible();
  await userEvent.keyboard('{Escape}');
});
