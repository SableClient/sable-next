// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type {
  NotificationModeView,
  NotificationSettingsView,
  RoomSummary,
} from '#src/generated/protocol';

import { roomNotifications, roomUnread } from '#lib/rooms/unread.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

const pageState = vi.hoisted(() => ({
  url: { pathname: '/home' },
  params: {},
  state: {},
}));

const roomsFixture = vi.hoisted(() => {
  const muteAware = {
    notificationMode: (roomId: string): NotificationModeView =>
      fixture.mutedRoomIds.has(roomId) ? 'mute' : 'all',
  };
  const fixture = {
    rooms: [] as RoomSummary[],
    mutedRoomIds: new Set<string>(),
    typingUsers: new Map<string, readonly string[]>(),
    byId: (roomId: string | null) => fixture.rooms.find((room) => room.room_id === roomId),
    notificationOverride: () => null,
    unreadFor: (room: RoomSummary) => roomUnread(room, fixture.notificationMode(room.room_id)),
    notificationsFor: (room: RoomSummary) =>
      roomNotifications(room, fixture.notificationMode(room.room_id)),
    ...muteAware,
    reset(): void {
      fixture.mutedRoomIds = new Set();
      Object.assign(fixture, muteAware);
    },
  };
  return fixture;
});

vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
const notificationSettings = vi.fn<(roomId: string) => Promise<NotificationSettingsView>>();
Object.assign(core, { notificationSettings });
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string> = {}) => {
    const resolved = (path.startsWith('/') ? path : `/${path}`).replace(
      /\[([^\]]+)\]/g,
      (_, key: string) => params[key] ?? key
    );
    return resolved.startsWith('/(app)') ? resolved.slice('/(app)'.length) : resolved;
  },
}));
vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => roomsFixture,
  findRoomByPathId: (rooms: readonly RoomSummary[], pathId: string | undefined) =>
    rooms.find((room) => room.room_id === pathId || room.canonical_alias === pathId),
  roomLabel: (room: RoomSummary) => room.name ?? room.canonical_alias ?? room.room_id,
  roomPathParam: (room: RoomSummary) => encodeURIComponent(room.canonical_alias ?? room.room_id),
  roomPathParamFromId: (roomId: string) => encodeURIComponent(roomId),
}));
const presenceFixture = vi.hoisted(() => ({
  entry: null as { statusMessage: string | null } | null,
}));

vi.mock('#lib/rooms/presence.svelte.js', () => ({
  usePresenceStore: () => ({ get: () => presenceFixture.entry }),
}));

import RoomNavHarness from './RoomNavHarness.test.svelte';

const realObserver = globalThis.IntersectionObserver;

function makeRoom(overrides: Partial<RoomSummary>): RoomSummary {
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
    room_type: null,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  };
}

function latestAt(timestamp: number): RoomSummary['latest_event'] {
  return { sender: null, body: 'hi', timestamp, sending: false, event_id: null };
}

function roomNames(): string[] {
  return Array.from(document.querySelectorAll('.room-row .room-name')).map(
    (node) => node.textContent
  );
}

async function mountNav(props: Record<string, unknown> = {}) {
  const instance = mount(RoomNavHarness, { target: document.body, props });
  await tick();
  return instance;
}

beforeEach(() => {
  pageState.url.pathname = '/home';
  pageState.params = {};
  roomsFixture.rooms = [];
  roomsFixture.reset();
  presenceFixture.entry = null;
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('no profile'));
  core.roomPermissions.mockReset();
  core.roomPermissions.mockResolvedValue({ can_invite: false, can_manage_children: false });
  notificationSettings.mockReset();
  notificationSettings.mockResolvedValue({ room: null, default: 'mentions' });
});

afterEach(() => {
  setPreference('showRoomIcon', 'always');
  document.body.replaceChildren();
  globalThis.IntersectionObserver = realObserver;
});

test.each([
  ['room', false],
  ['space', true],
])('enables Invite in a %s context menu when the user can invite', async (_, isSpace) => {
  const target = makeRoom({ room_id: '!plain:example.org', name: 'Plain', is_space: isSpace });
  roomsFixture.rooms = isSpace
    ? [
        makeRoom({
          room_id: '!root:example.org',
          name: 'Root',
          is_space: true,
          space_children: [
            {
              room_id: target.room_id,
              via: [],
              order: null,
              origin_server_ts: 1,
              suggested: false,
            },
          ],
        }),
        target,
      ]
    : [target];
  if (isSpace) {
    pageState.url.pathname = '/space/!root%3Aexample.org';
    pageState.params = { spaceId: '!root:example.org' };
  }
  core.roomPermissions.mockResolvedValue({ can_invite: true, can_manage_children: false });
  const instance = await mountNav();

  const trigger = Array.from(
    document.querySelectorAll<HTMLElement>('.room-row, .room-category')
  ).find((entry) => entry.textContent.includes('Plain'));
  if (!trigger) throw new Error('Room context-menu trigger missing');
  trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));

  await vi.waitFor(() => {
    expect(core.roomPermissions).toHaveBeenCalledWith('!plain:example.org');
  });
  const invite = Array.from(document.querySelectorAll<HTMLElement>('.menu-item')).find((item) =>
    item.textContent.includes('room.menuInvite')
  );
  if (!invite) throw new Error('Invite action missing');
  expect(invite.hasAttribute('data-disabled')).toBe(false);

  await unmount(instance);
});

test('home lists every joined room, including the children of joined spaces', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!plain:example.org', name: 'Plain' }),
    makeRoom({ room_id: '!direct:example.org', name: 'Direct', is_direct: true }),
    makeRoom({ room_id: '!space:example.org', name: 'Space', is_space: true }),
    makeRoom({ room_id: '!child:example.org', name: 'Child' }),
    makeRoom({
      room_id: '!parent-space:example.org',
      name: 'Parent space',
      is_space: true,
      space_children: [
        {
          room_id: '!child:example.org',
          via: [],
          order: null,
          origin_server_ts: 1,
          suggested: false,
        },
      ],
    }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['Plain', 'Direct', 'Child']);
  await unmount(instance);
});

test('home orders rooms by their latest event', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', latest_event: latestAt(10) }),
    makeRoom({ room_id: '!silent:example.org', name: 'Silent' }),
    makeRoom({ room_id: '!busy:example.org', name: 'Busy', latest_event: latestAt(30) }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['Busy', 'Quiet', 'Silent']);
  await unmount(instance);
});

test('favourites sit in their own section above the rest of the list', async () => {
  pageState.url.pathname = '/rooms';
  roomsFixture.rooms = [
    makeRoom({ room_id: '!busy:example.org', name: 'Busy', latest_event: latestAt(30) }),
    makeRoom({
      room_id: '!starred:example.org',
      name: 'Starred',
      tags: ['favourite'],
      latest_event: latestAt(10),
    }),
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', latest_event: latestAt(20) }),
  ];

  const instance = await mountNav();
  const favourites = Array.from(
    document.querySelectorAll('.room-list.favourites .room-row .room-name')
  ).map((node) => node.textContent);

  expect(favourites).toEqual(['Starred']);
  expect(roomNames()).toEqual(['Starred', 'Busy', 'Quiet']);
  expect(
    Array.from(document.querySelectorAll('.rooms-heading-label')).map((node) => node.textContent)
  ).toEqual(['nav.favourites', 'nav.rooms']);
  await unmount(instance);
});

test('a space lifts a favourite out of its subspace', async () => {
  pageState.url.pathname = '/space/!root%3Aexample.org';
  pageState.params = { spaceId: '!root:example.org' };
  const edge = (roomId: string) => ({
    room_id: roomId,
    via: [],
    order: null,
    origin_server_ts: 1,
    suggested: false,
  });
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!root:example.org',
      name: 'Root',
      is_space: true,
      space_children: [edge('!top:example.org'), edge('!nested:example.org')],
    }),
    makeRoom({
      room_id: '!nested:example.org',
      name: 'Nested',
      is_space: true,
      space_children: [edge('!deep:example.org')],
    }),
    makeRoom({ room_id: '!top:example.org', name: 'Top' }),
    makeRoom({ room_id: '!deep:example.org', name: 'Deep', tags: ['favourite'] }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['Deep', 'Top']);
  expect(document.querySelector('.room-list.favourites .room-row')?.getAttribute('href')).toBe(
    '/space/!root%3Aexample.org/!deep%3Aexample.org'
  );
  await unmount(instance);
});

test('home links a room to its own section', async () => {
  roomsFixture.rooms = [makeRoom({ room_id: '!plain:example.org', name: 'Plain' })];

  const instance = await mountNav();
  expect(document.querySelector('.room-row')?.getAttribute('href')).toBe(
    '/home/!plain%3Aexample.org'
  );
  await unmount(instance);
});

test('expanded room disclosures do not use the active-route surface', async () => {
  pageState.url.pathname = '/space/!root%3Aexample.org/!room%3Aexample.org';
  pageState.params = { spaceId: '!root:example.org' };
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!root:example.org',
      name: 'Root',
      is_space: true,
      space_children: [
        {
          room_id: '!nested:example.org',
          via: [],
          order: null,
          origin_server_ts: 1,
          suggested: false,
        },
      ],
    }),
    makeRoom({
      room_id: '!nested:example.org',
      name: 'Nested',
      is_space: true,
      space_children: [
        {
          room_id: '!room:example.org',
          via: [],
          order: null,
          origin_server_ts: 1,
          suggested: false,
        },
      ],
    }),
    makeRoom({ room_id: '!room:example.org', name: 'Current room' }),
  ];

  const instance = await mountNav();
  const current = document.querySelectorAll('.selection-current[aria-current="page"]');
  const expandedDisclosures = document.querySelectorAll(
    ':is(.rooms-heading, .room-category)[aria-expanded="true"]'
  );

  expect(current).toHaveLength(1);
  expect(current[0]?.classList.contains('room-row')).toBe(true);
  expect(expandedDisclosures).toHaveLength(2);
  expect(
    Array.from(expandedDisclosures).every((node) => !node.classList.contains('selection-open'))
  ).toBe(true);
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

test('the unspaced section leaves out rooms a joined space claims', async () => {
  pageState.url.pathname = '/rooms';
  roomsFixture.rooms = [
    makeRoom({ room_id: '!loose:example.org', name: 'Loose' }),
    makeRoom({ room_id: '!claimed:example.org', name: 'Claimed' }),
    makeRoom({
      room_id: '!space:example.org',
      name: 'Space',
      is_space: true,
      space_children: [
        {
          room_id: '!claimed:example.org',
          via: [],
          order: null,
          origin_server_ts: 1,
          suggested: false,
        },
      ],
    }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['Loose']);
  expect(document.querySelector('.room-row')?.getAttribute('href')).toBe(
    '/rooms/!loose%3Aexample.org'
  );
  await unmount(instance);
});

test('a claim from a space that is not joined keeps the room in the unspaced section', async () => {
  pageState.url.pathname = '/rooms';
  roomsFixture.rooms = [
    makeRoom({ room_id: '!claimed:example.org', name: 'Claimed' }),
    makeRoom({
      room_id: '!space:example.org',
      name: 'Space',
      is_space: true,
      state: 'invited',
      space_children: [
        {
          room_id: '!claimed:example.org',
          via: [],
          order: null,
          origin_server_ts: 1,
          suggested: false,
        },
      ],
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
      direct_targets: [],
      state: 'invited',
    }),
    makeRoom({ room_id: '!plain:example.org', name: 'Plain' }),
  ];

  const instance = await mountNav();
  expect(roomNames()).toEqual(['DM']);
  await unmount(instance);
});

test('direct page offers starting a chat and searching instead of creating or browsing rooms', async () => {
  pageState.url.pathname = '/direct';

  const instance = await mountNav();
  expect(
    Array.from(document.querySelectorAll('.room-nav-actions a')).map((node) =>
      node.getAttribute('href')
    )
  ).toEqual(['/direct', '/search']);
  expect(document.querySelector('.rooms-heading-label')?.textContent).toBe('nav.chats');
  expect(document.querySelector('.empty-rooms p')?.textContent).toBe('nav.chatsEmpty');
  await unmount(instance);
});

test('does not show a badge for a muted room', async () => {
  roomsFixture.rooms = [makeRoom({ room_id: '!muted:example.org', name: 'Muted', unread: 3 })];
  roomsFixture.mutedRoomIds = new Set(['!muted:example.org']);

  const instance = await mountNav();
  expect(document.querySelector('.unread-badge')).toBeNull();
  await unmount(instance);
});

test('a mentions-only room keeps its unread marker and badges its mentions', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', unread: 6 }),
    makeRoom({ room_id: '!pinged:example.org', name: 'Pinged', unread: 6, highlight: 2 }),
  ];
  roomsFixture.notificationMode = () => 'mentions';

  const instance = await mountNav();
  const rows = Array.from(document.querySelectorAll('.room-row'));
  const quiet = rows.find((row) => row.textContent.includes('Quiet'));
  const pinged = rows.find((row) => row.textContent.includes('Pinged'));

  expect(quiet?.querySelector('.unread-badge-dot')).not.toBeNull();
  expect(pinged?.querySelector('.unread-badge-count')?.textContent).toBe('2');
  await unmount(instance);
});

test('counts mentions in the badge, and quiet traffic only dots', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!mention:example.org', name: 'Mentioned', unread: 9, highlight: 2 }),
    makeRoom({ room_id: '!plain:example.org', name: 'Plain', unread: 5 }),
  ];
  roomsFixture.notificationMode = () => 'mentions';

  const instance = await mountNav();
  const rows = Array.from(document.querySelectorAll('.room-row'));
  const mentioned = rows.find((row) => row.textContent.includes('Mentioned'));
  const plain = rows.find((row) => row.textContent.includes('Plain'));

  expect(mentioned?.querySelector('.unread-badge-count')?.textContent).toBe('2');
  expect(plain?.querySelector('.unread-badge-count')).toBeNull();
  expect(plain?.querySelector('.unread-badge-dot')).not.toBeNull();
  await unmount(instance);
});

test('message search from a space is scoped to that space', async () => {
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!space:example.org',
      canonical_alias: '#design:example.org',
      name: 'Design',
      is_space: true,
    }),
  ];
  pageState.url.pathname = '/space/!space:example.org';
  pageState.params = { spaceId: '!space:example.org' };

  const instance = await mountNav();
  const search = Array.from(document.querySelectorAll('.room-nav-actions a')).find((node) =>
    node.getAttribute('href')?.startsWith('/search')
  );
  expect(search?.getAttribute('href')).toBe(
    `/search?q=${encodeURIComponent('space:#design:example.org ')}`
  );
  await unmount(instance);
});

test('a space list header shows the space banner above it', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!space:example.org', name: 'Design', is_space: true }),
  ];
  pageState.url.pathname = '/space/!space:example.org';
  pageState.params = { spaceId: '!space:example.org' };
  core.roomStateEvent.mockResolvedValue({
    type: 'page.codeberg.everypizza.room.banner',
    content: { url: 'mxc://example.org/banner' },
  });

  const instance = await mountNav();
  await tick();
  await tick();

  expect(core.roomStateEvent).toHaveBeenCalledWith(
    '!space:example.org',
    'page.codeberg.everypizza.room.banner'
  );
  expect(document.querySelector('.room-banner')).not.toBeNull();
  expect(document.querySelector('.room-nav-header')?.classList.contains('on-banner')).toBe(true);

  core.roomStateEvent.mockResolvedValue(null);
  await unmount(instance);
});

test('a space list header wears the space avatar when collapsed', async () => {
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!space:example.org',
      name: 'Design',
      is_space: true,
      join_rule: 'invite',
    }),
  ];
  pageState.url.pathname = '/space/!space:example.org';
  pageState.params = { spaceId: '!space:example.org' };

  const instance = await mountNav({ collapsed: true });
  const badge = document.querySelector('.room-nav-badge');
  expect(badge?.querySelector('.avatar-root')?.textContent.trim()).toBe('D');
  await unmount(instance);
});

test('a voice room shows a speaker icon and the live count', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!voice:example.org', name: 'Voice', is_voice: true }),
    makeRoom({
      room_id: '!busy:example.org',
      name: 'Busy voice',
      is_voice: true,
      call_participants: ['@a:example.org', '@b:example.org'],
    }),
  ];

  const instance = await mountNav();
  const icons = Array.from(document.querySelectorAll('.room-list .room-avatar-icon'));
  expect(icons).toHaveLength(2);
  expect(icons.every((icon) => icon.classList.contains('voice'))).toBe(true);
  expect(icons.every((icon) => icon.querySelector('svg') !== null)).toBe(true);
  expect(
    Array.from(document.querySelectorAll('.voice-badge')).map((node) => node.textContent)
  ).toEqual(['2']);
  await unmount(instance);
});

test('the collapsed icon mode uses generic glyphs until the sidebar is collapsed', async () => {
  setPreference('showRoomIcon', 'collapsed');
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!with-avatar:example.org',
      name: 'With avatar',
      avatar_url: 'mxc://avatar',
    }),
    makeRoom({ room_id: '!without-avatar:example.org', name: 'Without avatar' }),
  ];

  const expanded = await mountNav();
  expect(document.querySelectorAll('.room-row .room-icon')).toHaveLength(2);
  expect(document.querySelectorAll('.room-row .room-avatar-icon')).toHaveLength(0);
  await unmount(expanded);

  const compact = await mountNav({ collapsed: true });
  expect(document.querySelectorAll('.room-row .room-avatar-icon')).toHaveLength(2);
  expect(document.querySelectorAll('.room-row .room-icon')).toHaveLength(0);
  await unmount(compact);
});

test('the sometimes icon mode keeps existing avatars in an expanded sidebar', async () => {
  setPreference('showRoomIcon', 'sometimes');
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!with-avatar:example.org',
      name: 'With avatar',
      avatar_url: 'mxc://avatar',
    }),
    makeRoom({ room_id: '!without-avatar:example.org', name: 'Without avatar' }),
  ];

  const instance = await mountNav();
  expect(document.querySelectorAll('.room-row .room-avatar-icon')).toHaveLength(1);
  expect(document.querySelectorAll('.room-row .room-icon')).toHaveLength(1);
  await unmount(instance);
});

test('an active call in a text room shows the live count without the voice icon', async () => {
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!plain:example.org',
      name: 'Plain',
      call_participants: ['@a:example.org'],
    }),
  ];

  const instance = await mountNav();
  expect(document.querySelector('.room-list .room-avatar-icon')?.classList.contains('voice')).toBe(
    false
  );
  expect(document.querySelector('.voice-badge')?.textContent).toBe('1');
  await unmount(instance);
});

test('a live voice room lists its call members', async () => {
  observeImmediately();
  core.userProfile.mockImplementation((userId: string) =>
    Promise.resolve({
      user_id: userId,
      display_name: userId === '@alice:example.org' ? 'Alice' : 'Bob',
      avatar_url: null,
    })
  );
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!voice:example.org',
      name: 'Voice',
      is_voice: true,
      call_participants: ['@alice:example.org', '@bob:example.org'],
    }),
  ];

  const instance = await mountNav();
  await vi.waitFor(() => {
    expect(document.querySelector('.call-participant-list')?.textContent).toContain('Alice');
  });

  expect(document.querySelectorAll('.call-participant-list .avatar-root')).toHaveLength(2);
  expect(core.userProfile).toHaveBeenCalledWith('@alice:example.org');
  expect(core.userProfile).toHaveBeenCalledWith('@bob:example.org');
  await unmount(instance);
});

test('a collapsed live voice room keeps participant avatars labelled', async () => {
  observeImmediately();
  core.userProfile.mockResolvedValue({ display_name: 'Alice', avatar_url: null });
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!voice:example.org',
      name: 'Voice',
      is_voice: true,
      call_participants: ['@alice:example.org'],
    }),
  ];

  const instance = await mountNav({ collapsed: true });
  await vi.waitFor(() => {
    expect(
      document.querySelector('.call-participant-list .avatar-root')?.getAttribute('aria-label')
    ).toBe('Alice');
  });
  await unmount(instance);
});

function observeImmediately(): void {
  globalThis.IntersectionObserver = class {
    #callback: IntersectionObserverCallback;
    disconnect = () => {};
    unobserve = () => {};
    takeRecords = () => [];
    root = null;
    rootMargin = '';
    thresholds = [];
    constructor(callback: IntersectionObserverCallback) {
      this.#callback = callback;
    }
    observe() {
      this.#callback([{ isIntersecting: true }] as IntersectionObserverEntry[], this as never);
    }
  } as unknown as typeof IntersectionObserver;
}

function roomTopics(): (string | null)[] {
  return Array.from(document.querySelectorAll('.room-row .room-topic')).map(
    (node) => node.textContent
  );
}

test('a DM row shows the peer status once its profile arrives', async () => {
  observeImmediately();
  core.userProfile.mockResolvedValue({ status: { text: 'Shipping', emoji: '\u{1F680}' } });
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!dm:example.org',
      name: 'Bob',
      is_direct: true,
      direct_targets: ['@bob:example.org'],
    }),
  ];
  const instance = await mountNav();
  await tick();
  await tick();

  expect(core.userProfile).toHaveBeenCalledWith('@bob:example.org');
  expect(roomTopics()).toEqual(['\u{1F680}Shipping']);
  await unmount(instance);
});

test('a DM row falls back to the peer presence message, and a topic still wins', async () => {
  presenceFixture.entry = { statusMessage: 'In a meeting' };
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!dm:example.org',
      name: 'Bob',
      is_direct: true,
      direct_targets: ['@bob:example.org'],
    }),
  ];
  let instance = await mountNav();
  await tick();
  expect(roomTopics()).toEqual(['In a meeting']);
  await unmount(instance);

  document.body.replaceChildren();
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!dm:example.org',
      name: 'Bob',
      topic: 'Ship logs',
      is_direct: true,
      direct_targets: ['@bob:example.org'],
    }),
  ];
  instance = await mountNav();
  await tick();
  expect(roomTopics()).toEqual(['Ship logs']);
  await unmount(instance);
});

test('hovering a collapsed room row shows its full name in a tooltip', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!long:example.org', name: 'A very long room name that truncates' }),
  ];
  const instance = await mountNav({ collapsed: true });
  await tick();

  const row = document.querySelector<HTMLElement>('.room-row');
  if (!row) throw new Error('room row was not rendered');
  vi.useFakeTimers();
  row.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
  await vi.advanceTimersByTimeAsync(400);
  await tick();

  expect(document.querySelector('.tooltip')?.textContent.trim()).toBe(
    'A very long room name that truncates'
  );
  vi.useRealTimers();
  await unmount(instance);
});

test('a muted room marked unread by hand keeps its dot and no count', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!muted:example.org', name: 'Muted', unread: 9, marked_unread: true }),
  ];
  roomsFixture.mutedRoomIds = new Set(['!muted:example.org']);

  const instance = await mountNav();
  const row = Array.from(document.querySelectorAll('.room-row')).find((entry) =>
    entry.textContent.includes('Muted')
  );

  expect(row?.querySelector('.unread-badge-dot')).not.toBeNull();
  expect(row?.querySelector('.unread-badge-count')).toBeNull();
  await unmount(instance);
});

test('a room set to all messages badges its unread messages in green', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!loud:example.org', name: 'Loud', unread: 6 }),
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', unread: 6 }),
  ];
  roomsFixture.notificationMode = (roomId: string) =>
    roomId === '!loud:example.org' ? 'all' : 'mentions';

  const instance = await mountNav();
  const rows = Array.from(document.querySelectorAll('.room-row'));
  const loud = rows.find((row) => row.textContent.includes('Loud'));
  const quiet = rows.find((row) => row.textContent.includes('Quiet'));

  expect(loud?.querySelector('.unread-badge-count')?.textContent).toBe('6');
  expect(loud?.querySelector('.unread-badge-highlight')).not.toBeNull();
  expect(quiet?.querySelector('.unread-badge-dot')).not.toBeNull();
  expect(quiet?.querySelector('.unread-badge-highlight')).toBeNull();
  await unmount(instance);
});
