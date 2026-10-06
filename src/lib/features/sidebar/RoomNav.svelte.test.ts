// @vitest-environment happy-dom

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';

import type {
  NotificationModeView,
  NotificationSettingsView,
  RoomSummary,
} from '#src/generated/protocol';

import { roomNotifications, roomUnread } from '#lib/rooms/unread.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

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
    badgeUnreadFor: (room: RoomSummary) => roomUnread(room, fixture.notificationMode(room.room_id)),
    quietRoomIds: new Set<string>(),
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

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { visit } from '#lib/test-support/app-state.js';
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
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomsFixture,
  roomLabel: (room: RoomSummary) => room.name ?? room.canonical_alias ?? room.room_id,
  roomAvatarUrl: (room: RoomSummary) => room.avatar_url,
}));
const presenceFixture = vi.hoisted(() => ({
  entry: null as { statusMessage: string | null } | null,
}));

vi.mock('#lib/rooms/presence.svelte.js', () => ({
  usePresenceStore: () => ({ get: () => presenceFixture.entry, peek: () => presenceFixture.entry }),
}));

import { setGroupsFavourites } from './favourite-grouping.svelte.js';
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
    notifying: 0,
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
  const instance = render(RoomNavHarness, { props });
  await tick();
  return instance;
}

const user = userEvent.setup();
const row = (name: string) => screen.getByRole('link', { name: new RegExp(`^${name}`) });

async function openMenu(name: string): Promise<void> {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByText(name) });
}

beforeEach(() => {
  visit('/home', {});
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
    is_space: isSpace,
    space_children: isSpace ? [leaf] : [],
  });
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
        makeRoom({ room_id: leaf.room_id, name: 'Leaf' }),
      ]
    : [target];
  if (isSpace) {
    visit('/space/!root%3Aexample.org', { spaceId: '!root:example.org' });
  }
  core.roomPermissions.mockResolvedValue({ can_invite: true, can_manage_children: false });
  await mountNav();

  await openMenu('Plain');

  await vi.waitFor(() => {
    expect(core.roomPermissions).toHaveBeenCalledWith('!plain:example.org');
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
      is_space: true,
      space_children: [edge('!one:example.org')],
    }),
    makeRoom({
      room_id: '!one:example.org',
      name: 'One',
      is_space: true,
      space_children: [edge('!two:example.org')],
    }),
    makeRoom({
      room_id: '!two:example.org',
      name: 'Two',
      is_space: true,
      space_children: [edge('!deep:example.org'), edge('!three:example.org')],
    }),
    makeRoom({
      room_id: '!three:example.org',
      name: 'Three',
      is_space: true,
      space_children: [edge('!deepest:example.org')],
    }),
    makeRoom({ room_id: '!deep:example.org', name: 'Deep' }),
    makeRoom({ room_id: '!deepest:example.org', name: 'Deepest' }),
  ];

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

  await mountNav();
  expect(roomNames()).toEqual(['Plain', 'Direct', 'Child']);
});

test('home orders rooms by their latest event', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', latest_event: latestAt(10) }),
    makeRoom({ room_id: '!silent:example.org', name: 'Silent' }),
    makeRoom({ room_id: '!busy:example.org', name: 'Busy', latest_event: latestAt(30) }),
  ];

  await mountNav();
  expect(roomNames()).toEqual(['Busy', 'Quiet', 'Silent']);
});

test('favourites sit in their own section above the rest of the list', async () => {
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

test('a view that stops grouping favourites keeps them in recency order', async () => {
  visit('/rooms');
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
  setGroupsFavourites('unspaced', false);

  await mountNav();
  expect(document.querySelector('.room-list.favourites')).not.toBeInTheDocument();
  expect(roomNames()).toEqual(['Busy', 'Quiet', 'Starred']);
  setGroupsFavourites('unspaced', true);
});

test('a space lifts a favourite out of its subspace', async () => {
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

  await mountNav();
  expect(roomNames()).toEqual(['Deep', 'Top']);
  expect(row('Deep')).toHaveAttribute('href', '/space/!root%3Aexample.org/!deep%3Aexample.org');
});

test('home links a room to its own section', async () => {
  roomsFixture.rooms = [makeRoom({ room_id: '!plain:example.org', name: 'Plain' })];

  await mountNav();
  expect(row('Plain')).toHaveAttribute('href', '/home/!plain%3Aexample.org');
});

test('expanded room disclosures do not use the active-route surface', async () => {
  visit('/space/!root%3Aexample.org/!room%3Aexample.org', { spaceId: '!root:example.org' });
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

  await mountNav();
  const current = screen.getAllByRole('link', { current: 'page' });
  const expandedDisclosures = screen.getAllByRole('button', { expanded: true });

  expect(current).toHaveLength(1);
  expect(current[0]).toHaveClass('room-row', 'selection-current');
  expect(expandedDisclosures).toHaveLength(2);
  expect(
    Array.from(expandedDisclosures).every((node) => !node.classList.contains('selection-open'))
  ).toBe(true);
});

test('home leaves out invited and knocked rooms', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!joined:example.org', name: 'Joined' }),
    makeRoom({ room_id: '!invited:example.org', name: 'Invited', state: 'invited' }),
    makeRoom({ room_id: '!knocked:example.org', name: 'Knocked', state: 'knocked' }),
  ];

  await mountNav();
  expect(roomNames()).toEqual(['Joined']);
});

test('the unspaced section leaves out rooms a joined space claims', async () => {
  visit('/rooms');
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

  await mountNav();
  expect(roomNames()).toEqual(['Loose']);
  expect(row('Loose')).toHaveAttribute('href', '/rooms/!loose%3Aexample.org');
});

test('a claim from a space that is not joined keeps the room in the unspaced section', async () => {
  visit('/rooms');
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

  await mountNav();
  expect(roomNames()).toEqual(['Claimed']);
});

test('direct page lists joined direct rooms only', async () => {
  visit('/direct');
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

  await mountNav();
  expect(roomNames()).toEqual(['DM']);
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

test('does not show a badge for a muted room', async () => {
  roomsFixture.rooms = [makeRoom({ room_id: '!muted:example.org', name: 'Muted', unread: 3 })];
  roomsFixture.mutedRoomIds = new Set(['!muted:example.org']);

  await mountNav();
  expect(row('Muted').querySelector('.unread-badge')).not.toBeInTheDocument();
});

test('a mentions-only room keeps its unread marker and badges its mentions', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!quiet:example.org', name: 'Quiet', unread: 6 }),
    makeRoom({ room_id: '!pinged:example.org', name: 'Pinged', unread: 6, highlight: 2 }),
  ];
  roomsFixture.notificationMode = () => 'mentions';

  await mountNav();
  expect(row('Quiet').querySelector('.unread-badge-dot')).toBeInTheDocument();
  expect(within(row('Pinged')).getByText('2')).toHaveClass('unread-badge-count');
});

test('counts mentions in the badge, and quiet traffic only dots', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!mention:example.org', name: 'Mentioned', unread: 9, highlight: 2 }),
    makeRoom({ room_id: '!plain:example.org', name: 'Plain', unread: 5 }),
  ];
  roomsFixture.notificationMode = () => 'mentions';

  await mountNav();
  expect(within(row('Mentioned')).getByText('2')).toHaveClass('unread-badge-count');
  expect(row('Plain').querySelector('.unread-badge-count')).not.toBeInTheDocument();
  expect(row('Plain').querySelector('.unread-badge-dot')).toBeInTheDocument();
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
    makeRoom({ room_id: '!space:example.org', name: 'Design', is_space: true }),
  ];
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });

  await mountNav();
  expect(screen.queryByRole('button', { name: 'nav.createRoomInSpace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'nav.joinWithAddress' })).not.toBeInTheDocument();

  core.roomPermissions.mockResolvedValue({ can_invite: false, can_manage_children: true });
  cleanup();
  await mountNav();
  expect(await screen.findByRole('button', { name: 'nav.createRoomInSpace' })).toBeInTheDocument();
});

test('a space list header shows the space banner above it', async () => {
  roomsFixture.rooms = [
    makeRoom({ room_id: '!space:example.org', name: 'Design', is_space: true }),
  ];
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });
  core.roomStateEvent.mockResolvedValue({
    type: 'page.codeberg.everypizza.room.banner',
    content: { url: 'mxc://example.org/banner' },
  });

  await mountNav();
  await tick();
  await tick();

  expect(core.roomStateEvent).toHaveBeenCalledWith(
    '!space:example.org',
    'page.codeberg.everypizza.room.banner'
  );
  expect(document.querySelector('.room-banner')).not.toBeNull();
  expect(document.querySelector('.room-nav-header')).toHaveClass('on-banner');

  core.roomStateEvent.mockResolvedValue(null);
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
  visit('/space/!space:example.org', { spaceId: '!space:example.org' });

  await mountNav({ collapsed: true });
  const badge = document.querySelector('.room-nav-badge');
  expect(badge?.querySelector('.avatar-root')?.textContent.trim()).toBe('D');
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
      is_voice: true,
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
      is_voice: true,
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
    makeRoom({ room_id: '!muted:example.org', name: 'Muted', unread: 9, marked_unread: true }),
  ];
  roomsFixture.mutedRoomIds = new Set(['!muted:example.org']);

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
  roomsFixture.notificationMode = (roomId: string) =>
    roomId === '!loud:example.org' ? 'all' : 'mentions';

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
  Object.assign(core, { unjoinedSpaceParents, roomPreview, joinRoom });
  await mountNav();

  await openMenu('Plain');
  const join = await screen.findByRole('menuitem', {
    name: 'room.menuJoinParentSpace:Parent',
  });
  await user.click(join);

  expect(unjoinedSpaceParents).toHaveBeenCalledWith('!plain:example.org');
  expect(roomPreview).toHaveBeenCalledWith('!parent:example.org', ['example.org']);
  await vi.waitFor(() => {
    expect(joinRoom).toHaveBeenCalledWith('!parent:example.org', ['example.org']);
  });
});
