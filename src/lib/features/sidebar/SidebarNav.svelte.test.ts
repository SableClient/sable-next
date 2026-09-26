// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import type { CoreEvent, RoomSummary } from '#src/generated/protocol';

const pageState = vi.hoisted(() => ({
  url: { pathname: '/home', search: '', hash: '' },
  state: {},
}));
const navigation = vi.hoisted(() => ({ afterNavigate: null as (() => void) | null }));

vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/navigation', () => ({
  goto: () => Promise.resolve(),
  afterNavigate: (callback: () => void) => {
    navigation.afterNavigate = callback;
  },
}));
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
    subscribe(
      run: (value: { t: (key: string, params?: Record<string, string>) => string }) => void
    ) {
      run({
        t: (key: string, params?: Record<string, string>) =>
          params === undefined ? key : `${key}:${Object.values(params).join(',')}`,
      });
      return () => {};
    },
  },
}));
const fixture = vi.hoisted(() => ({ roomList: null as RoomList | null }));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => fixture.roomList,
}));
const sidebarFixture = vi.hoisted(() => ({
  items: [] as { kind: 'space'; room_id: string }[],
}));
vi.mock('#lib/spaces/sidebar-layout.svelte.js', () => ({
  useSpaceSidebar: () => ({ items: sidebarFixture.items, openFolders: new Set() }),
}));
vi.mock('#lib/features/call/call-session.svelte.js', () => ({
  useCallSession: () => ({ active: false, roomId: null }),
}));
vi.mock('./RoomNav.svelte', () => ({ default: () => null }));
vi.mock('./UserQuickTools.svelte', () => ({ default: () => null }));
vi.mock('./FolderRenameDialog.svelte', () => ({ default: () => null }));
vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

core.roomPermissions.mockResolvedValue({ can_manage_children: false });
vi.mock('#lib/ui/primitives/Tooltip.svelte', () => ({ default: () => null }));

import SidebarNav from './SidebarNav.svelte';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import type { CoreClient } from '#lib/core/client.svelte.js';

afterEach(() => {
  localStorage.clear();
  sidebarFixture.items = [];
});

function space(roomId = '!space:example.org', name = 'Space'): RoomSummary {
  return {
    room_id: roomId,
    canonical_alias: null,
    name,
    topic: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: true,
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
  };
}

async function startRoomList(core: CoreClient): Promise<RoomList> {
  const roomList = new RoomList(core);
  fixture.roomList = roomList;
  onTestFinished(() => {
    roomList.stop();
    fixture.roomList = null;
  });
  await roomList.start();
  return roomList;
}

function railOrder(names: readonly string[]): (string | null)[] {
  return screen
    .getAllByRole('link')
    .map((link) => link.getAttribute('aria-label'))
    .filter((name) => name !== null && names.includes(name));
}

test('adds an incoming unread DM to the navbar and removes it when read', async () => {
  const room: RoomSummary = {
    ...space('!dm:example.org', 'Alice'),
    is_space: false,
    is_direct: true,
    direct_targets: ['@alice:example.org'],
  };
  const listeners = new Set<(event: CoreEvent) => void>();
  const core = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [room] }),
      notificationSettings: () => Promise.resolve({ room: null, default: 'all' }),
      unsubscribe: () => Promise.resolve(),
    },
  } as unknown as CoreClient;
  await startRoomList(core);
  render(SidebarNav, { mobile: true });
  await tick();

  expect(screen.queryByRole('link', { name: 'Alice' })).not.toBeInTheDocument();

  const incoming = {
    ...room,
    unread: 1,
    notifying: 1,
    latest_event: {
      sender: '@alice:example.org',
      body: 'Hello',
      timestamp: 1000,
      sending: false,
      event_id: '$message',
    },
  };
  for (const listener of listeners)
    listener({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'set', index: 0, value: incoming }],
    });
  await tick();

  const dm = screen.getByRole('link', { name: 'Alice' });
  expect(dm).toHaveAttribute('href', '/direct/!dm%3Aexample.org');
  expect(within(dm).getByText('1').closest('.unread-badge')).toBeInTheDocument();
  expect(dm).toHaveAccessibleDescription('nav.unreadMessages:1');

  for (const listener of listeners)
    listener({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'set', index: 0, value: { ...incoming, unread: 0 } }],
    });
  await tick();

  expect(screen.queryByRole('link', { name: 'Alice' })).not.toBeInTheDocument();
});

test('keeps the rail order when a room-list reset reorders spaces', async () => {
  const alpha = space('!alpha:example.org', 'Alpha');
  const beta = space('!beta:example.org', 'Beta');
  const listeners = new Set<(event: CoreEvent) => void>();
  const core = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [alpha, beta] }),
      roomNotificationModes: () => Promise.resolve([]),
      unsubscribe: () => Promise.resolve(),
    },
  } as unknown as CoreClient;
  await startRoomList(core);
  render(SidebarNav, { mobile: true });
  await tick();

  expect(railOrder(['Alpha', 'Beta'])).toEqual(['Alpha', 'Beta']);

  for (const listener of listeners) {
    listener({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'reset', values: [beta, alpha] }],
    });
  }
  await tick();

  expect(railOrder(['Alpha', 'Beta'])).toEqual(['Alpha', 'Beta']);
});

test('a subspace pinned in the stored layout joins the rail beside its parent', async () => {
  const child = space('!child:example.org', 'Child');
  const parent = {
    ...space('!parent:example.org', 'Parent'),
    space_children: [
      { room_id: child.room_id, via: [], order: null, origin_server_ts: 1, suggested: false },
    ],
  };
  const core = {
    subscribeEvents: () => () => {},
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [parent, child] }),
      roomNotificationModes: () => Promise.resolve([]),
      unsubscribe: () => Promise.resolve(),
    },
  } as unknown as CoreClient;
  await startRoomList(core);

  const first = render(SidebarNav, { mobile: true });
  await tick();
  expect(railOrder(['Child', 'Parent'])).toEqual(['Parent']);
  first.unmount();

  sidebarFixture.items = [{ kind: 'space', room_id: child.room_id }];
  render(SidebarNav, { mobile: true });
  await tick();
  expect(railOrder(['Child', 'Parent'])).toEqual(['Child', 'Parent']);
});

test('a muted direct chat marked unread by hand still reaches the navbar', async () => {
  const room: RoomSummary = {
    ...space('!muted:example.org', 'Bo'),
    is_space: false,
    is_direct: true,
    direct_targets: ['@bo:example.org'],
    marked_unread: true,
  };
  const core = {
    subscribeEvents: () => () => {},
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [room] }),
      roomNotificationModes: (roomIds: readonly string[]) =>
        Promise.resolve(
          roomIds.map((room_id) => ({ room_id, room: 'mute' as const, default: 'all' as const }))
        ),
      unsubscribe: () => Promise.resolve(),
    },
  } as unknown as CoreClient;
  const roomList = await startRoomList(core);
  await vi.waitFor(() => {
    expect(roomList.notificationMode(room.room_id)).toBe('mute');
  });

  render(SidebarNav, { mobile: true });
  await tick();

  expect(screen.getByRole('link', { name: 'Bo' })).toHaveAttribute(
    'href',
    '/direct/!muted%3Aexample.org'
  );
});

test('a muted room marked unread by hand still marks its section as unread', async () => {
  const room: RoomSummary = {
    ...space('!muted-room:example.org', 'Ops'),
    is_space: false,
    marked_unread: true,
  };
  const core = {
    subscribeEvents: () => () => {},
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [room] }),
      roomNotificationModes: (roomIds: readonly string[]) =>
        Promise.resolve(
          roomIds.map((room_id) => ({ room_id, room: 'mute' as const, default: 'all' as const }))
        ),
      unsubscribe: () => Promise.resolve(),
    },
  } as unknown as CoreClient;
  const roomList = await startRoomList(core);
  await vi.waitFor(() => {
    expect(roomList.notificationMode(room.room_id)).toBe('mute');
  });

  render(SidebarNav, { mobile: true });
  await tick();

  const rooms = screen.getByRole('link', { name: 'nav.unspaced' });
  expect(rooms.querySelector('.unread-badge-dot')).toBeInTheDocument();
});

test('a section totals its notifying rooms in green', async () => {
  const room: RoomSummary = {
    ...space('!loud:example.org', 'Loud'),
    is_space: false,
    unread: 4,
    notifying: 4,
  };
  const core = {
    subscribeEvents: () => () => {},
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [room] }),
      roomNotificationModes: (roomIds: readonly string[]) =>
        Promise.resolve(
          roomIds.map((room_id) => ({ room_id, room: 'all' as const, default: 'all' as const }))
        ),
      unsubscribe: () => Promise.resolve(),
    },
  } as unknown as CoreClient;
  const roomList = await startRoomList(core);
  await vi.waitFor(() => {
    expect(roomList.notificationMode(room.room_id)).toBe('all');
  });

  render(SidebarNav, { mobile: true });
  await tick();

  const rooms = screen.getByRole('link', { name: 'nav.unspaced' });
  expect(within(rooms).getByText('4').closest('.unread-badge')).toHaveClass(
    'unread-badge-highlight'
  );
});
