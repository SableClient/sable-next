// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '@/generated/RoomSummary';

const pageState = vi.hoisted(() => ({
  url: { pathname: '/home' },
  params: {},
}));

const roomsFixture = vi.hoisted(() => ({
  rooms: [] as RoomSummary[],
  mutedRoomIds: new Set<string>(),
}));

const coreStub = vi.hoisted(() => ({
  roomPermissions: vi.fn(() => new Promise<never>(() => {})),
  session: null,
}));

vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$lib/core/context', () => ({ useCoreClient: () => coreStub }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/i18n', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));
vi.mock('$lib/rooms/room-list.svelte', () => ({
  useRoomList: () => roomsFixture,
  findRoomByPathId: (rooms: readonly RoomSummary[], pathId: string | undefined) =>
    rooms.find((room) => room.room_id === pathId || room.canonical_alias === pathId),
  roomPathParam: (room: RoomSummary) => encodeURIComponent(room.canonical_alias ?? room.room_id),
  roomPathParamFromId: (roomId: string) => encodeURIComponent(roomId),
}));

import RoomNav from './RoomNav.svelte';

function makeRoom(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    room_id: '!room:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    avatar_url: null,
    is_direct: false,
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: false,
    has_space_parent: false,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    highlight: 0,
    latest_event: null,
    ...overrides,
  };
}

function roomNames(): string[] {
  return Array.from(document.querySelectorAll('.room-row .room-name')).map(
    (node) => node.textContent
  );
}

async function mountNav() {
  const instance = mount(RoomNav, { target: document.body });
  await tick();
  return instance;
}

beforeEach(() => {
  pageState.url.pathname = '/home';
  pageState.params = {};
  roomsFixture.rooms = [];
  roomsFixture.mutedRoomIds = new Set();
});

afterEach(() => {
  document.body.replaceChildren();
});

test('home lists joined rooms that are not direct, spaces, or space children', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!plain:example.org', name: 'Plain' }),
    makeRoom({ room_id: '!direct:example.org', name: 'Direct', is_direct: true }),
    makeRoom({ room_id: '!space:example.org', name: 'Space', is_space: true }),
    makeRoom({ room_id: '!child:example.org', name: 'Child' }),
    makeRoom({
      room_id: '!parent-space:example.org',
      name: 'Parent space',
      is_space: true,
      space_children: [{ room_id: '!child:example.org', order: null, origin_server_ts: 1 }],
    }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['Plain']);
  await unmount(instance);
});

test('home leaves out invited and knocked rooms', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!joined:example.org', name: 'Joined' }),
    makeRoom({ room_id: '!invited:example.org', name: 'Invited', state: 'invited' }),
    makeRoom({ room_id: '!knocked:example.org', name: 'Knocked', state: 'knocked' }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['Joined']);
  await unmount(instance);
});

test('a joined space claiming a room hides it from home', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!claimed:example.org', name: 'Claimed' }),
    makeRoom({
      room_id: '!space:example.org',
      name: 'Space',
      is_space: true,
      space_children: [{ room_id: '!claimed:example.org', order: null, origin_server_ts: 1 }],
    }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual([]);
  await unmount(instance);
});

test('a claim from a space that is not joined keeps the room in home', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!claimed:example.org', name: 'Claimed' }),
    makeRoom({
      room_id: '!space:example.org',
      name: 'Space',
      is_space: true,
      state: 'invited',
      space_children: [{ room_id: '!claimed:example.org', order: null, origin_server_ts: 1 }],
    }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['Claimed']);
  await unmount(instance);
});

test('direct page lists joined direct rooms only', async () => {
  pageState.url.pathname = '/direct';
  roomsFixture.rooms = [
    makeRoom({ room_id: '!dm:example.org', name: 'DM', is_direct: true }),
    makeRoom({
      room_id: '!invited-dm:example.org',
      name: 'Invited DM',
      is_direct: true,
      state: 'invited',
    }),
    makeRoom({ room_id: '!plain:example.org', name: 'Plain' }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['DM']);
  await unmount(instance);
});

test('direct page offers starting a chat instead of creating or browsing rooms', async () => {
  pageState.url.pathname = '/direct';

  const instance = await mountNav();
  expect(
    Array.from(document.querySelectorAll('.room-nav-actions a')).map((node) =>
      node.getAttribute('href')
    )
  ).toEqual(['/direct']);
  expect(document.querySelector('.rooms-heading-label')?.textContent).toBe('nav.chats');
  expect(document.querySelector('.empty-rooms p')?.textContent).toBe('nav.chatsEmpty');
  await unmount(instance);
});

test('does not show a badge for a muted room', async () => {
  roomsFixture.rooms = [makeRoom({ room_id: '!muted:example.org', name: 'Muted', unread: 3 })];
  roomsFixture.mutedRoomIds = new Set(['!muted:example.org']);

  const instance = await mountNav();
  expect(document.querySelector('.room-badge')).toBeNull();
  await unmount(instance);
});
