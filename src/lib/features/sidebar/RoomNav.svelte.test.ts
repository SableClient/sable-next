import type { RoomPermissionsView } from '#src/generated/protocol';
// @vitest-environment happy-dom

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';

import type {
  NotificationSettingsView,
  RoomListItemView,
  RoomSectionView,
  RoomUnreadView,
} from '#src/generated/protocol';

import { roomNotifications, roomUnread } from '#lib/rooms/unread.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { bannerChanged } from '#lib/features/room/room-banner.svelte.js';
import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';

const roomsFixture = vi.hoisted(() => {
  const fixture = {
    rooms: [] as RoomListItemView[],
    typingUsers: new Map<string, readonly string[]>(),
    byId: (roomId: string | null) => fixture.rooms.find((room) => room.room_id === roomId),
    notificationOverride: () => null,
    unreadFor: (room: RoomListItemView) => roomUnread(room),
    sections: new Map<string, RoomSectionView>(),
    badges: new Map<string, RoomUnreadView>(),
    section: (key: string): RoomSectionView =>
      fixture.sections.get(key) ?? {
        key,
        favourites: [],
        rooms: fixture.rooms.map((room) => room.room_id),
        subspaces: [],
        calendars: [],
        invites: [],
        unread: { unread: 0, notifying: 0, highlight: 0, marked: false },
        unread_rooms: [],
        descendants: [],
      },
    badgeUnreadFor: (room: RoomListItemView): RoomUnreadView =>
      fixture.badges.get(room.room_id) ?? { unread: 0, notifying: 0, highlight: 0, marked: false },
    quietRoomIds: new Set<string>(),
    notificationsFor: (room: RoomListItemView) => roomNotifications(room),
  };
  return fixture;
});

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { visit } from '#lib/test-support/app-state.js';
vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';
const notificationSettings =
  vi.fn<(params: { room_id: string }) => Promise<NotificationSettingsView>>();
Object.assign(core.rpc.notifications, { settings: notificationSettings });
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string> = {}) => {
    const resolved = (path.startsWith('/') ? path : `/${path}`).replace(
      /\[([^\]]+)\]/g,
      (_, key: string) => params[key] ?? key
    );
    return resolved.startsWith('/(app)') ? resolved.slice('/(app)'.length) : resolved;
  },
}));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomsFixture,
}));
const presenceFixture = vi.hoisted(() => ({
  entry: null as { statusMessage: string | null } | null,
}));

vi.mock('#lib/rooms/presence.svelte.js', () => ({
  usePresenceStore: () => ({ get: () => presenceFixture.entry, peek: () => presenceFixture.entry }),
}));

import {
  badgeView,
  sectionView,
  treeCategory,
  treeLink,
  treeRoom,
} from '#lib/test-support/room-sections.js';
import RoomNavHarness from './RoomNavHarness.test.svelte';

const realObserver = globalThis.IntersectionObserver;

function makeRoom(overrides: Partial<RoomListItemView>): RoomListItemView {
  return withCounts({
    room_id: '!room:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_tombstoned: false,
    call_participants: [],
    screen_sharers: [],
    room_kind: 'text',
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    bridge: null,
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  });
}

function listSections(...sections: RoomSectionView[]): void {
  roomsFixture.sections = new Map(sections.map((section) => [section.key, section]));
}

function listBadges(entries: Record<string, Partial<RoomUnreadView>>): void {
  roomsFixture.badges = new Map(
    Object.entries(entries).map(([id, counts]) => {
      const { counts: full } = badgeView(id, counts);
      return [id, full];
    })
  );
}

function roomNames(): string[] {
  return Array.from(document.querySelectorAll('.room-row .room-name')).map(
    (node) => node.textContent
  );
}

async function mountNav(props: Record<string, unknown> = {}) {
  const instance = render(RoomNavHarness, { props });
  await tick();
  return instance;
}

const user = userEvent.setup();
const row = (name: string) => screen.getByRole('treeitem', { name: new RegExp(`^${name}`) });

async function openMenu(name: string): Promise<void> {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByText(name) });
}

beforeEach(() => {
  visit('/home', {});
  core.session = { user_id: '@me:example.org' };
  roomsFixture.rooms = [];
  roomsFixture.sections = new Map();
  roomsFixture.badges = new Map();
  presenceFixture.entry = null;
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('no profile'));
  core.rpc.members.permissions.mockReset();
  core.rpc.members.permissions.mockResolvedValue({
    can_invite: false,
    can_manage_children: false,
  } as RoomPermissionsView);
  core.rpc.room_state.banner.mockReset();
  core.rpc.room_state.banner.mockResolvedValue(null);
  notificationSettings.mockReset();
  notificationSettings.mockResolvedValue({ room: null, default: 'mentions' });
});

afterEach(() => {
  mediaViewerState.close();
  setPreference('showHome', false);
  setPreference('roomSort', 'recent');
  setPreference('directSort', 'recent');
  setPreference('showRoomIcon', 'always');
  setPreference('showDmTopics', true);
  globalThis.IntersectionObserver = realObserver;
});

test.each([
  ['room', false],
  ['space', true],
])('enables Invite in a %s context menu when the user can invite', async (_, isSpace) => {
  const leaf = {
    room_id: '!leaf:example.org',
    via: [],
    order: null,
    origin_server_ts: 1,
    suggested: false,
  };
  const target = makeRoom({
    room_id: '!plain:example.org',
    name: 'Plain',
    room_kind: isSpace ? 'space' : 'text',
    space_children: isSpace ? [leaf] : [],
  });
  roomsFixture.rooms = isSpace
    ? [
        makeRoom({
          room_id: '!root:example.org',
          name: 'Root',
          room_kind: 'space',
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
        makeRoom({ room_id: leaf.room_id, name: 'Leaf' }),
      ]
    : [target];
  if (isSpace) {
    visit('/space/!root%3Aexample.org', { spaceId: '!root:example.org' });
    listSections(
      sectionView('!root:example.org', {
        subspaces: [treeCategory(target.room_id, 0, [treeRoom(leaf.room_id, 1)])],
      })
    );
  }
  core.rpc.members.permissions.mockResolvedValue({
    can_invite: true,
    can_manage_children: false,
  } as RoomPermissionsView);
  await mountNav();

  await openMenu('Plain');

  await vi.waitFor(() => {
    expect(core.rpc.members.permissions).toHaveBeenCalledWith({ room_id: '!plain:example.org' });
  });
  const invite = await screen.findByRole('menuitem', { name: /room\.menuInvite/ });
  await vi.waitFor(() => {
    expect(invite).not.toHaveAttribute('data-disabled');
  });
});

test('a subspace context menu opens its lobby', async () => {
  visit('/space/!root%3Aexample.org', { spaceId: '!root:example.org' });
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!root:example.org',
      name: 'Root',
      room_kind: 'space',
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
      room_kind: 'space',
      space_children: [
        {
          room_id: '!leaf:example.org',
          via: [],
          order: null,
          origin_server_ts: 1,
          suggested: false,
        },
      ],
    }),
    makeRoom({ room_id: '!leaf:example.org', name: 'Leaf' }),
  ];
  listSections(
    sectionView('!root:example.org', {
      subspaces: [treeCategory('!nested:example.org', 0, [treeRoom('!leaf:example.org', 1)])],
    })
  );
  const onNavigate = vi.fn();
  await mountNav({ onNavigate });

  await openMenu('Nested');
  await user.click(await screen.findByRole('menuitem', { name: /nav\.lobby/ }));

  expect(onNavigate).toHaveBeenCalledWith('/space/!nested%3Aexample.org/lobby');
});

test('nests subspaces with thread lines and links past the depth limit to the lobby', async () => {
  visit('/space/!root%3Aexample.org', { spaceId: '!root:example.org' });
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
      room_kind: 'space',
      space_children: [edge('!one:example.org')],
    }),
    makeRoom({
      room_id: '!one:example.org',
      name: 'One',
      room_kind: 'space',
      space_children: [edge('!two:example.org')],
    }),
    makeRoom({
      room_id: '!two:example.org',
      name: 'Two',
      room_kind: 'space',
      space_children: [edge('!deep:example.org'), edge('!three:example.org')],
    }),
    makeRoom({
      room_id: '!three:example.org',
      name: 'Three',
      room_kind: 'space',
      space_children: [edge('!deepest:example.org')],
    }),
    makeRoom({ room_id: '!deep:example.org', name: 'Deep' }),
    makeRoom({ room_id: '!deepest:example.org', name: 'Deepest' }),
  ];

  listSections(
    sectionView('!root:example.org', {
      subspaces: [
        treeCategory('!one:example.org', 0, [
          treeCategory('!two:example.org', 0, [
            treeRoom('!deep:example.org', 1),
            treeLink('!three:example.org', 1),
          ]),
        ]),
      ],
    })
  );
  await mountNav();
  const deep = row('Deep');
  expect(deep.style.getPropertyValue('--room-depth')).toBe('1');
  expect(deep.parentElement?.querySelectorAll('.thread-line, .thread-elbow')).toHaveLength(2);

  const link = row('Three');
  expect(link).toHaveAttribute('href', '/space/!three%3Aexample.org/lobby');
  expect(link.parentElement?.querySelectorAll('.thread-line')).toHaveLength(0);
  expect(link.parentElement?.querySelectorAll('.thread-elbow')).toHaveLength(1);
  expect(roomNames()).not.toContain('Deepest');
});

test('each page renders its section in the order the core lists it', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!a:example.org', name: 'A' }),
    makeRoom({ room_id: '!b:example.org', name: 'B' }),
    makeRoom({ room_id: '!c:example.org', name: 'C', is_direct: true }),
    makeRoom({ room_id: '!d:example.org', name: 'D', is_direct: true }),
  ];
  listSections(
    sectionView('home', { rooms: ['!d:example.org', '!b:example.org', '!c:example.org'] }),
    sectionView('unspaced', { rooms: ['!b:example.org', '!a:example.org'] }),
    sectionView('direct', { rooms: ['!d:example.org', '!c:example.org'] })
  );

  const home = await mountNav();
  expect(roomNames()).toEqual(['D', 'B', 'C']);
  home.unmount();

  visit('/rooms');
  const unspaced = await mountNav();
  expect(roomNames()).toEqual(['B', 'A']);
  unspaced.unmount();

  visit('/direct');
  await mountNav();
  expect(roomNames()).toEqual(['D', 'C']);
});

test('rows past the first screens render their details once they come near the viewport', async () => {
  const callbacks = new Map<Element, IntersectionObserverCallback>();
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
    observe(node: Element) {
      callbacks.set(node, this.#callback);
    }
  } as unknown as typeof IntersectionObserver;
  const ids = Array.from({ length: 60 }, (_, at) => `!r${String(at)}:example.org`);
  roomsFixture.rooms = ids.map((roomId, at) =>
    makeRoom({ room_id: roomId, name: `Room ${String(at)}` })
  );
  listSections(sectionView('unspaced', { rooms: ids }));
  visit('/rooms');
  await mountNav();

  const near = document.querySelector<HTMLElement>('[data-row-key="!r0:example.org"]');
  const far = document.querySelector<HTMLElement>('[data-row-key="!r59:example.org"]');
  if (!near || !far) throw new Error('the rows were not rendered');
  expect(document.querySelectorAll('[data-row-key] .room-name')).toHaveLength(60);
  expect(near.querySelector('.room-options-slot')).not.toBeNull();
  expect(far.querySelector('.room-options-slot')).toBeNull();

  callbacks.get(far)?.(
    [{ isIntersecting: true, target: far }] as unknown as IntersectionObserverEntry[],
    null as never
  );
  await tick();

  expect(far.querySelector('.room-options-slot')).not.toBeNull();
});

test('favourites sit in their own section above the rest of the list', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!busy:example.org', name: 'Busy' }),
    makeRoom({
      room_id: '!starred:example.org',
      name: 'Starred',
      tags: ['favourite'],
    }),
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet' }),
  ];
  listSections(
    sectionView('home', {
      favourites: ['!starred:example.org'],
      rooms: ['!busy:example.org', '!quiet:example.org'],
    })
  );

  await mountNav();
  const favourites = Array.from(
    document.querySelectorAll('.room-list.favourites .room-row .room-name')
  ).map((node) => node.textContent);

  expect(favourites).toEqual(['Starred']);
  expect(roomNames()).toEqual(['Starred', 'Busy', 'Quiet']);
  expect(
    Array.from(document.querySelectorAll('.rooms-heading-label')).map((node) => node.textContent)
  ).toEqual(['nav.favourites', 'nav.rooms']);
});

test('a space lists the favourite the core lifted out of its subspace', async () => {
  visit('/space/!root%3Aexample.org', { spaceId: '!root:example.org' });
  roomsFixture.rooms = [
    makeRoom({ room_id: '!root:example.org', name: 'Root', room_kind: 'space' }),
    makeRoom({ room_id: '!top:example.org', name: 'Top' }),
    makeRoom({ room_id: '!deep:example.org', name: 'Deep', tags: ['favourite'] }),
  ];
  listSections(
    sectionView('!root:example.org', {
      favourites: ['!deep:example.org'],
      rooms: ['!top:example.org'],
    })
  );

  await mountNav();
  expect(roomNames()).toEqual(['Deep', 'Top']);
  expect(row('Deep')).toHaveAttribute('href', '/space/!root%3Aexample.org/!deep%3Aexample.org');
});

test('home links a room to its own section when enabled', async () => {
  setPreference('showHome', true);
  roomsFixture.rooms = [makeRoom({ room_id: '!plain:example.org', name: 'Plain' })];

  await mountNav();
  expect(row('Plain')).toHaveAttribute('href', '/home/!plain%3Aexample.org');
});

test('explore links rooms to their sections when Home is disabled', async () => {
  visit('/explore');
  setPreference('showHome', false);
  roomsFixture.rooms = [
    makeRoom({ room_id: '!plain:example.org', name: 'Plain' }),
    makeRoom({ room_id: '!dm:example.org', name: 'Chat', is_direct: true }),
    makeRoom({ room_id: '!child:example.org', name: 'Child' }),
    makeRoom({
      room_id: '!space:example.org',
      name: 'Space',
      room_kind: 'space',
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
  listSections(
    sectionView('home', {
      rooms: ['!plain:example.org', '!dm:example.org', '!child:example.org'],
    })
  );

  await mountNav();

  expect(row('Plain')).toHaveAttribute('href', '/rooms/!plain%3Aexample.org');
  expect(row('Chat')).toHaveAttribute('href', '/direct/!dm%3Aexample.org');
  expect(row('Child')).toHaveAttribute('href', '/space/!space%3Aexample.org/!child%3Aexample.org');
});

test('a room listed by a space section links through that space', async () => {
  visit('/space/!root%3Aexample.org', { spaceId: '!root:example.org' });
  roomsFixture.rooms = [
    makeRoom({ room_id: '!root:example.org', name: 'Root', room_kind: 'space' }),
    makeRoom({ room_id: '!old:example.org', name: 'Old room', is_tombstoned: true }),
  ];
  listSections(sectionView('!root:example.org', { rooms: ['!old:example.org'] }));

  await mountNav();

  expect(roomNames()).toEqual(['Old room']);
  expect(row('Old room')).toHaveAttribute('href', '/space/!root%3Aexample.org/!old%3Aexample.org');
});

test('expanded room disclosures do not use the active-route surface', async () => {
  visit('/space/!root%3Aexample.org/!room%3Aexample.org', { spaceId: '!root:example.org' });
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!root:example.org',
      name: 'Root',
      room_kind: 'space',
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
      room_kind: 'space',
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
  listSections(
    sectionView('!root:example.org', {
      subspaces: [treeCategory('!nested:example.org', 0, [treeRoom('!room:example.org', 1)])],
    })
  );

  await mountNav();
  const current = screen.getAllByRole('treeitem', { current: 'page' });
  const expandedDisclosures = screen.getAllByRole('treeitem', { expanded: true });

  expect(current).toHaveLength(1);
  expect(current[0]).toHaveClass('room-row', 'selection-current');
  expect(expandedDisclosures).toHaveLength(2);
  expect(
    Array.from(expandedDisclosures).every((node) => !node.classList.contains('selection-open'))
  ).toBe(true);
});

test('direct page offers starting a chat and searching instead of creating or browsing rooms', async () => {
  visit('/direct');

  await mountNav();
  expect(
    Array.from(document.querySelectorAll('.room-nav-actions a')).map((node) =>
      node.getAttribute('href')
    )
  ).toEqual(['/direct', '/search']);
  expect(document.querySelector('.rooms-heading-label')?.textContent).toBe('nav.chats');
  expect(document.querySelector('.empty-rooms p')?.textContent).toBe('nav.chatsEmpty');
});

test('a row shows the badge the core gives it and none otherwise', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!silent:example.org', name: 'Silent', unread: 3 }),
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', unread: 6 }),
    makeRoom({ room_id: '!pinged:example.org', name: 'Pinged', unread: 6, highlight: 2 }),
  ];
  listBadges({
    '!quiet:example.org': { unread: 6 },
    '!pinged:example.org': { unread: 2, highlight: 2 },
  });

  await mountNav();
  expect(row('Silent').querySelector('.unread-badge')).not.toBeInTheDocument();
  expect(row('Quiet').querySelector('.unread-badge-dot')).toBeInTheDocument();
  expect(row('Quiet').querySelector('.unread-badge-count')).not.toBeInTheDocument();
  expect(within(row('Pinged')).getByText('2')).toHaveClass('unread-badge-count');
});

test('message search from a space is scoped to that space', async () => {
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!space:example.org',
      canonical_alias: '#design:example.org',
      name: 'Design',
      room_kind: 'space',
    }),
  ];
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });

  await mountNav();
  const search = screen
    .getAllByRole('link')
    .find((node) => node.getAttribute('href')?.startsWith('/search'));
  expect(search?.getAttribute('href')).toBe(
    `/search?q=${encodeURIComponent('space:#design:example.org ')}&space=!space%3Aexample.org`
  );
});

test('a space you cannot add rooms to does not show a create action', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!space:example.org', name: 'Design', room_kind: 'space' }),
  ];
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });

  await mountNav();
  expect(screen.queryByRole('button', { name: 'nav.createRoomInSpace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'nav.joinWithAddress' })).not.toBeInTheDocument();

  core.rpc.members.permissions.mockResolvedValue({
    can_invite: false,
    can_manage_children: true,
  } as RoomPermissionsView);
  cleanup();
  await mountNav();
  expect(await screen.findByRole('button', { name: 'nav.createRoomInSpace' })).toBeInTheDocument();
});

test('a space list header shows the space banner above it', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!space:example.org', name: 'Design', room_kind: 'space' }),
  ];
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });
  core.rpc.room_state.banner.mockResolvedValue('mxc://example.org/banner');

  await mountNav();
  await tick();
  await tick();

  expect(core.rpc.room_state.banner).toHaveBeenCalledWith({ room_id: '!space:example.org' });
  expect(document.querySelector('.room-banner')).not.toBeNull();
  expect(document.querySelector('.room-nav-header')).toHaveClass('on-banner');
});

async function expectBanner(source: string, name: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `common.viewBanner:${name}` }));
  expect(mediaViewerState.standaloneItem).toMatchObject({ source, filename: name });
  mediaViewerState.close();
}

test.each([
  ['prefers the room banner', 'room', 'space', 'room', 'General'],
  ['falls back to the space banner', null, 'space', 'space', 'Design'],
  ['shows a room banner when the space has none', 'room', null, 'room', 'General'],
  ['hides the banner when neither room nor space has one', null, null, null, null],
])('%s', async (_, roomBanner, spaceBanner, expected, name) => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!space:example.org', name: 'Design', room_kind: 'space' }),
    makeRoom({
      room_id: '!room:example.org',
      name: 'General',
      canonical_alias: '#general:example.org',
    }),
  ];
  visit('/space/!space:example.org/%23general:example.org', {
    spaceId: '!space:example.org',
    roomId: '#general:example.org',
  });
  core.rpc.room_state.banner.mockImplementation(({ room_id }) => {
    const banner = room_id === '!space:example.org' ? spaceBanner : roomBanner;
    return Promise.resolve(banner === null ? null : `mxc://example.org/${banner}`);
  });

  await mountNav();
  await tick();
  await tick();

  expect(core.rpc.room_state.banner).toHaveBeenCalledWith({ room_id: '!room:example.org' });
  if (expected !== null) {
    await expectBanner(`mxc://example.org/${expected}`, name);
  } else {
    expect(document.querySelector('.room-banner')).toBeNull();
    expect(document.querySelector('.room-nav-header')).not.toHaveClass('on-banner');
  }
});

test('room switches ignore late banner responses and reuse the space fallback', async () => {
  const first = Promise.withResolvers<string | null>();
  const revisit = Promise.withResolvers<string | null>();
  roomsFixture.rooms = [
    makeRoom({ room_id: '!space:example.org', name: 'Design', room_kind: 'space' }),
    makeRoom({ room_id: '!first:example.org', name: 'First' }),
    makeRoom({ room_id: '!second:example.org', name: 'Second' }),
  ];
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });
  core.rpc.room_state.banner.mockImplementation(({ room_id }) => {
    if (room_id === '!space:example.org') return Promise.resolve('mxc://example.org/space');
    return room_id === '!first:example.org' ? first.promise : Promise.resolve(null);
  });

  const view = await mountNav({ roomId: '!first:example.org' });
  await expectBanner('mxc://example.org/space', 'Design');
  await view.rerender({ roomId: '!second:example.org' });
  first.resolve('mxc://example.org/stale');
  await tick();
  await tick();
  await expectBanner('mxc://example.org/space', 'Design');

  core.rpc.room_state.banner.mockImplementation(() => revisit.promise);
  await view.rerender({ roomId: '!first:example.org' });
  await expectBanner('mxc://example.org/space', 'Design');
  revisit.resolve('mxc://example.org/current');
  await expectBanner('mxc://example.org/current', 'First');
  expect(
    core.rpc.room_state.banner.mock.calls.filter(
      ([params]) => params.room_id === '!space:example.org'
    )
  ).toHaveLength(1);

  core.rpc.room_state.banner.mockResolvedValue(null);
  await view.rerender({ roomId: '!second:example.org' });
  await expectBanner('mxc://example.org/space', 'Design');

  await view.rerender({ roomId: undefined });
  await expectBanner('mxc://example.org/space', 'Design');
});

test('refreshes a changed room banner and restores the space banner when it is removed', async () => {
  let roomBanner: string | null = 'mxc://example.org/original';
  roomsFixture.rooms = [
    makeRoom({ room_id: '!space:example.org', name: 'Design', room_kind: 'space' }),
    makeRoom({ room_id: '!room:example.org', name: 'General' }),
  ];
  visit('/space/!space:example.org/!room:example.org', {
    spaceId: '!space:example.org',
    roomId: '!room:example.org',
  });
  core.rpc.room_state.banner.mockImplementation(({ room_id }) =>
    Promise.resolve(room_id === '!space:example.org' ? 'mxc://example.org/space' : roomBanner)
  );

  await mountNav();
  await expectBanner('mxc://example.org/original', 'General');

  roomBanner = 'mxc://example.org/replacement';
  bannerChanged();
  await tick();
  await tick();
  await expectBanner(roomBanner, 'General');

  roomBanner = null;
  bannerChanged();
  await expectBanner('mxc://example.org/space', 'Design');
});

test('a space list header wears the space avatar when collapsed', async () => {
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!space:example.org',
      name: 'Design',
      room_kind: 'space',
      join_rule: 'invite',
    }),
  ];
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });

  await mountNav({ collapsed: true });
  const badge = document.querySelector('.room-nav-badge');
  expect(badge?.querySelector('.avatar-root')?.textContent.trim()).toBe('D');
});

test('a voice room shows a speaker icon and the live count', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!voice:example.org', name: 'Voice', room_kind: 'voice' }),
    makeRoom({
      room_id: '!busy:example.org',
      name: 'Busy voice',
      room_kind: 'voice',
      call_participants: ['@a:example.org', '@b:example.org'],
    }),
  ];

  await mountNav();
  const icons = Array.from(document.querySelectorAll('.room-list .room-avatar-icon'));
  expect(icons).toHaveLength(2);
  expect(icons.every((icon) => icon.classList.contains('voice'))).toBe(true);
  expect(icons.every((icon) => icon.querySelector('svg') !== null)).toBe(true);
  expect(
    Array.from(document.querySelectorAll('.voice-live .status-badge')).map(
      (node) => node.textContent
    )
  ).toEqual(['2']);
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
  expanded.unmount();

  await mountNav({ collapsed: true });
  expect(document.querySelectorAll('.room-row .room-avatar-icon')).toHaveLength(2);
  expect(document.querySelectorAll('.room-row .room-icon')).toHaveLength(0);
});

test('a collapsed row carries the unread badge of its room', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!unread:example.org', name: 'Unread', unread: 4 }),
    makeRoom({ room_id: '!read:example.org', name: 'Read' }),
  ];
  listBadges({ '!unread:example.org': { unread: 4 } });

  await mountNav({ collapsed: true });
  const rows = Array.from(document.querySelectorAll('.room-row'));
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.querySelectorAll('.room-collapsed-badge').length)).toEqual([1, 0]);
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

  await mountNav();
  expect(document.querySelectorAll('.room-row .room-avatar-icon')).toHaveLength(1);
  expect(document.querySelectorAll('.room-row .room-icon')).toHaveLength(1);
});

test('direct messages and unspaced rooms without an avatar show their initial', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!dm:example.org', name: 'alice', is_direct: true }),
    makeRoom({ room_id: '!room:example.org', name: 'Garden' }),
  ];
  listSections(sectionView('unspaced', { rooms: ['!room:example.org'] }));

  const home = await mountNav({ collapsed: true });
  const homeIcons = Array.from(document.querySelectorAll('.room-row .room-avatar-icon'));
  expect(homeIcons.map((icon) => icon.textContent.trim())).toEqual(['A', '']);
  expect(homeIcons[1]?.querySelector('svg')).not.toBeNull();
  home.unmount();

  visit('/rooms');
  await mountNav({ collapsed: true });
  const icon = document.querySelector('.room-row .room-avatar-icon');
  expect(icon?.textContent.trim()).toBe('G');
  expect(icon?.querySelector('svg')).toBeNull();
});

test('an active call in a text room shows the live count without the voice icon', async () => {
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!plain:example.org',
      name: 'Plain',
      call_participants: ['@a:example.org'],
    }),
  ];

  await mountNav();
  expect(document.querySelector('.room-list .room-avatar-icon')?.classList.contains('voice')).toBe(
    false
  );
  expect(document.querySelector('.voice-live .status-badge')?.textContent).toBe('1');
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
      room_kind: 'voice',
      call_participants: ['@alice:example.org', '@bob:example.org'],
    }),
  ];

  await mountNav();
  await vi.waitFor(() => {
    expect(document.querySelector('.call-participant-list')?.textContent).toContain('Alice');
  });

  expect(document.querySelectorAll('.call-participant-list .avatar-root')).toHaveLength(2);
  expect(core.userProfile).toHaveBeenCalledWith('@alice:example.org');
  expect(core.userProfile).toHaveBeenCalledWith('@bob:example.org');
});

test('a participant sharing their screen is tagged live to people outside the call', async () => {
  observeImmediately();
  core.userProfile.mockImplementation((userId: string) =>
    Promise.resolve({
      display_name: userId === '@bob:example.org' ? 'Bob' : 'Alice',
      avatar_url: null,
    })
  );
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!voice:example.org',
      name: 'Voice',
      room_kind: 'voice',
      call_participants: ['@alice:example.org', '@bob:example.org'],
      screen_sharers: ['@bob:example.org'],
    }),
  ];

  await mountNav();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.call-participant-list li')).toHaveLength(2);
  });

  const tagged = document.querySelectorAll('.call-participant-list .voice-stream');
  expect(tagged).toHaveLength(1);
  await vi.waitFor(() => {
    expect(tagged[0]?.closest('li')?.textContent).toContain('Bob');
  });
});

test('a collapsed live voice room keeps participant avatars labelled', async () => {
  observeImmediately();
  core.userProfile.mockResolvedValue({ display_name: 'Alice', avatar_url: null });
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!voice:example.org',
      name: 'Voice',
      room_kind: 'voice',
      call_participants: ['@alice:example.org'],
    }),
  ];

  await mountNav({ collapsed: true });
  await vi.waitFor(() => {
    expect(
      document.querySelector('.call-participant-list .avatar-root')?.getAttribute('aria-label')
    ).toBe('Alice');
  });
});

test('a user in a voice room on two devices is listed once per device', async () => {
  observeImmediately();
  core.userProfile.mockResolvedValue({ display_name: 'Alice', avatar_url: null });
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!voice:example.org',
      name: 'Voice',
      room_kind: 'voice',
      call_participants: ['@alice:example.org', '@alice:example.org'],
    }),
  ];

  await mountNav();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.call-participant-list li')).toHaveLength(2);
  });
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
  visit('/direct');
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
  await mountNav();
  await tick();
  await tick();

  expect(core.userProfile).toHaveBeenCalledWith('@bob:example.org');
  expect(roomTopics()).toEqual(['\u{1F680}Shipping']);
});

test('does not show our own or an arbitrary target status on a DM row', async () => {
  visit('/direct');
  presenceFixture.entry = { statusMessage: 'My status' };
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!self:example.org',
      name: 'Self',
      is_direct: true,
      direct_targets: ['@me:example.org'],
    }),
    makeRoom({
      room_id: '!group:example.org',
      name: 'Group',
      is_direct: true,
      direct_targets: ['@alice:example.org', '@bob:example.org'],
    }),
  ];
  await mountNav();
  expect(roomTopics()).toEqual([]);
});

test('does not show a target status before the session is known', async () => {
  visit('/direct');
  core.session = null;
  presenceFixture.entry = { statusMessage: 'My status' };
  roomsFixture.rooms = [
    makeRoom({ name: 'Chat', is_direct: true, direct_targets: ['@me:example.org'] }),
  ];
  await mountNav();
  expect(roomTopics()).toEqual([]);
});

test('a DM row falls back to the peer presence message, and a topic still wins', async () => {
  visit('/direct');
  presenceFixture.entry = { statusMessage: 'In a meeting' };
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
  expect(roomTopics()).toEqual(['In a meeting']);
  instance.unmount();
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!dm:example.org',
      name: 'Bob',
      topic: 'Ship logs',
      is_direct: true,
      direct_targets: ['@bob:example.org'],
    }),
  ];
  await mountNav();
  await tick();
  expect(roomTopics()).toEqual(['Ship logs']);
});

test('a DM topic is hidden in favour of the peer status when topics are turned off', async () => {
  visit('/direct');
  setPreference('showDmTopics', false);
  presenceFixture.entry = { statusMessage: 'In a meeting' };
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!dm:example.org',
      name: 'Bob',
      topic: 'Ship logs',
      is_direct: true,
      direct_targets: ['@bob:example.org'],
    }),
  ];
  await mountNav();
  await tick();

  expect(roomTopics()).toEqual(['In a meeting']);
});

test('hovering a collapsed room row shows its full name in a tooltip', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!long:example.org', name: 'A very long room name that truncates' }),
  ];
  await mountNav({ collapsed: true });
  await tick();

  const longRow = row('A very long room name');
  vi.useFakeTimers();
  const hover = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  await hover.hover(longRow);
  await vi.advanceTimersByTimeAsync(400);
  await tick();

  expect(document.querySelector('.tooltip')?.textContent.trim()).toBe(
    'A very long room name that truncates'
  );
  vi.useRealTimers();
});

test('a muted room marked unread by hand keeps its dot and no count', async () => {
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!muted:example.org',
      name: 'Muted',
      unread: 9,
      marked_unread: true,
      notification: { room: 'mute', default: 'all' },
    }),
  ];
  listBadges({ '!muted:example.org': { marked: true } });

  await mountNav();
  expect(row('Muted').querySelector('.unread-badge-dot')).toBeInTheDocument();
  expect(row('Muted').querySelector('.unread-badge-count')).not.toBeInTheDocument();
});

test('a room set to all messages badges its unread messages in green', async () => {
  setPreference('showUnreadCounts', true);
  onTestFinished(() => {
    setPreference('showUnreadCounts', false);
  });
  roomsFixture.rooms = [
    makeRoom({ room_id: '!loud:example.org', name: 'Loud', unread: 6, notifying: 6 }),
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', unread: 6 }),
  ];
  listBadges({
    '!loud:example.org': { unread: 6, notifying: 6 },
    '!quiet:example.org': { unread: 6 },
  });

  await mountNav();
  expect(within(row('Loud')).getByText('6')).toHaveClass(
    'unread-badge-count',
    'unread-badge-highlight'
  );
  expect(within(row('Quiet')).getByText('6')).toHaveClass('unread-badge-count');
  expect(row('Quiet').querySelector('.unread-badge-highlight')).not.toBeInTheDocument();
});

test('a room whose parent space we are not in offers to join it', async () => {
  roomsFixture.rooms = [makeRoom({ room_id: '!plain:example.org', name: 'Plain' })];
  const unjoinedSpaceParents = vi.fn(() =>
    Promise.resolve([{ room_id: '!parent:example.org', via: ['example.org'] }])
  );
  const roomPreview = vi.fn(() => Promise.resolve({ name: 'Parent' }));
  const joinRoom = vi.fn(() => Promise.resolve('!parent:example.org'));
  Object.assign(core.rpc.rooms, { preview: roomPreview, join: joinRoom });
  Object.assign(core.rpc.spaces, { unjoinedSpaceParents });
  await mountNav();

  await openMenu('Plain');
  const joinSpace = await screen.findByRole('menuitem', { name: 'room.menuJoinSpace' });
  await vi.waitFor(() => {
    expect(joinSpace).not.toHaveAttribute('data-disabled');
  });
  await user.click(joinSpace);
  const join = await screen.findByRole('menuitem', {
    name: 'room.menuJoinParentSpace:Parent',
  });
  await user.click(join);

  expect(unjoinedSpaceParents).toHaveBeenCalledWith({ room_id: '!plain:example.org' });
  expect(roomPreview).toHaveBeenCalledWith({
    address: '!parent:example.org',
    via: ['example.org'],
  });
  await vi.waitFor(() => {
    expect(joinRoom).toHaveBeenCalledWith({ address: '!parent:example.org', via: ['example.org'] });
  });
});

test('a row options button opens the shared room menu and closes it again', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!first:example.org', name: 'First' }),
    makeRoom({ room_id: '!second:example.org', name: 'Second' }),
  ];
  await mountNav();

  const triggers = screen.getAllByLabelText('room.menuLabel');
  expect(triggers).toHaveLength(2);
  expect(screen.queryByRole('menu')).toBeNull();

  const [, second] = triggers;
  await user.click(second);

  const menu = await screen.findByRole('menu');
  expect(second).toHaveAttribute('aria-expanded', 'true');
  await vi.waitFor(() => {
    expect(core.rpc.members.permissions).toHaveBeenCalledWith({ room_id: '!second:example.org' });
  });
  expect(within(menu).getByRole('menuitem', { name: /room\.menuSettings/ })).toBeInTheDocument();

  await user.click(second);

  await vi.waitFor(() => {
    expect(screen.queryByRole('menu')).toBeNull();
  });
  expect(second).toHaveAttribute('aria-expanded', 'false');
});

test('closing the rooms section hides read rows without unmounting them', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!read:example.org', name: 'Read' }),
    makeRoom({
      room_id: '!unread:example.org',
      name: 'Unread',
      unread: 3,
    }),
  ];
  listBadges({ '!unread:example.org': { unread: 3 } });
  await mountNav();
  const readRow = row('Read');
  const heading = screen.getByRole('treeitem', { name: 'nav.rooms' });

  await user.click(heading);

  expect(heading).toHaveAttribute('aria-expanded', 'false');
  expect(readRow.closest('.room-row-wrap')).toHaveClass('closed-row');
  expect(row('Unread').closest('.room-row-wrap')).not.toHaveClass('closed-row');

  await user.click(heading);

  expect(row('Read')).toBe(readRow);
  expect(readRow.closest('.room-row-wrap')).not.toHaveClass('closed-row');
});

test('the replaced rooms section collapses and stays collapsed', async () => {
  visit('/rooms');
  roomsFixture.rooms = [
    makeRoom({ room_id: '!old:example.org', name: 'Old room', is_tombstoned: true }),
  ];

  const nav = await mountNav();
  const heading = screen.getByRole('button', { name: 'room.replacedTitle 1' });
  expect(heading).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Old room', { selector: '.replaced-name' })).toBeInTheDocument();

  await user.click(heading);
  expect(heading).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Old room', { selector: '.replaced-name' })).toBeNull();
  nav.unmount();

  await mountNav();
  expect(screen.getByRole('button', { name: 'room.replacedTitle 1' })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await user.click(screen.getByRole('button', { name: 'room.replacedTitle 1' }));
});

test('the room list is one tree with a single tab stop and the row actions out of the tab order', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!a:example.org', name: 'Alpha' }),
    makeRoom({ room_id: '!b:example.org', name: 'Beta' }),
  ];
  await mountNav();

  const tree = screen.getByRole('tree', { name: 'nav.rooms' });
  expect(
    within(tree)
      .getAllByRole('treeitem')
      .filter((item) => item.tabIndex === 0)
  ).toHaveLength(1);
  expect(row('Alpha')).toHaveAttribute('aria-level', '2');
  for (const trigger of screen.getAllByLabelText('room.menuLabel')) {
    expect(trigger).toHaveAttribute('tabindex', '-1');
  }

  screen.getByRole('treeitem', { name: 'nav.rooms' }).focus();
  await user.keyboard('{ArrowDown}');
  expect(row('Alpha')).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByRole('treeitem', { name: 'nav.rooms' })).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByRole('treeitem', { name: 'nav.rooms' })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
});

test('a bridged room carries its network on the avatar, a native one does not', async () => {
  visit('/direct');
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!discord:example.org',
      name: 'Friend',
      is_direct: true,
      bridge: { network: 'Discord', avatar_url: 'mxc://example.org/discord' },
    }),
    makeRoom({ room_id: '!native:example.org', name: 'Native', is_direct: true }),
  ];
  await mountNav();

  const rowOf = (name: string) => screen.getByText(name).closest<HTMLElement>('[role="treeitem"]');
  expect(
    within(rowOf('Friend') as HTMLElement).getByRole('img', { name: 'nav.bridgedFrom:Discord' })
  ).toBeInTheDocument();
  expect(rowOf('Native')?.querySelector('.room-bridge')).toBeNull();
});

test('bridge badges leave the room icons when the preference is off', async () => {
  visit('/direct');
  setPreference('showBridgeBadges', false);
  roomsFixture.rooms = [
    makeRoom({
      room_id: '!discord:example.org',
      name: 'Friend',
      is_direct: true,
      bridge: { network: 'Discord', avatar_url: null },
    }),
  ];
  await mountNav();

  expect(screen.getByText('Friend')).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'nav.bridgedFrom:Discord' })).toBeNull();
  setPreference('showBridgeBadges', true);
});
