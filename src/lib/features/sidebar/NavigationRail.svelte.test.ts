// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';

const pageState = vi.hoisted(() => ({ url: { pathname: '/home', search: '', hash: '' } }));
const navigation = vi.hoisted(() => ({ afterNavigate: null as (() => void) | null }));

vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/navigation', () => ({
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
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParam: (room: RoomSummary) => encodeURIComponent(room.room_id),
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => ({
    commands: {
      roomPermissions: () => Promise.resolve({ can_manage_children: false }),
      roomViaServers: () => Promise.resolve([]),
      setRoomTag: () => Promise.resolve(),
      markRead: () => Promise.resolve(),
    },
  }),
}));
vi.mock('#lib/ui/primitives/Tooltip.svelte', () => ({ default: () => null }));

import NavigationRail from './NavigationRail.svelte';
import { savedSpacePaths, spaceNavigationHref } from './space-paths.js';

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
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
    has_space_parent: false,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
  };
}

test('badges unread direct chats but leaves home alone', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [],
      homeUnread: { unread: 4, highlight: 2 },
      directUnread: { unread: 3, highlight: 3 },
      mobile: true,
    },
  });
  await tick();

  expect(document.querySelector('a[href="/home"] .sable-unread-badge')).toBeNull();
  expect(document.querySelector('a[href="/direct"] .sable-unread-badge-count')?.textContent).toBe(
    '3'
  );

  await unmount(instance);
});

test('badges the unspaced section, which home no longer repeats', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [],
      homeUnread: { unread: 9, highlight: 5 },
      unspacedUnread: { unread: 4, highlight: 2 },
      mobile: true,
    },
  });
  await tick();

  expect(document.querySelector('a[href="/home"] .sable-unread-badge')).toBeNull();
  expect(document.querySelector('a[href="/rooms"] .sable-unread-badge-count')?.textContent).toBe(
    '2'
  );

  await unmount(instance);
});

test('uses a dot for ordinary unread messages outside spaces', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [], unspacedUnread: { unread: 2, highlight: 0 }, mobile: true },
  });
  await tick();

  expect(document.querySelector('a[href="/rooms"] .sable-unread-badge-dot')).not.toBeNull();
  expect(document.querySelector('a[href="/rooms"] .sable-unread-badge-count')).toBeNull();

  await unmount(instance);
});

test('shows unread direct rooms as individual avatars', async () => {
  const directRoom = {
    room_id: '!dm:example.org',
    canonical_alias: null,
    name: 'Alice',
    topic: null,
    avatar_url: null,
    is_direct: true,
    direct_targets: [],
    join_rule: 'invite' as const,
    tags: [],
    state: 'joined' as const,
    encrypted: null,
    is_space: false,
    is_tombstoned: false,
    is_voice: false,
    call_participants: [],
    has_space_parent: false,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 2,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
  } satisfies RoomSummary;
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [], directRooms: [directRoom], mobile: true },
  });
  await tick();

  const directLink = document.querySelector('a[href="/direct/!dm%3Aexample.org"]');
  expect(directLink?.getAttribute('aria-label')).toBe('Alice');
  expect(directLink?.querySelector('.space-initial')?.textContent.trim()).toBe('A');
  expect(directLink?.querySelector('.sable-unread-badge-count')?.textContent).toBe('2');
  expect(directLink?.querySelector('.sable-unread-badge-dot')).toBeNull();

  await unmount(instance);
});

test('badges a space with its mentions and dots one with only unread messages', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [space('!a:example.org', 'Alpha'), space('!b:example.org', 'Beta')],
      spaceUnread: new Map([
        ['!a:example.org', { unread: 7, highlight: 3 }],
        ['!b:example.org', { unread: 4, highlight: 0 }],
      ]),
      mobile: true,
    },
  });
  await tick();

  const alpha = document.querySelector('a[aria-label="Alpha"]');
  const beta = document.querySelector('a[aria-label="Beta"]');
  expect(alpha?.querySelector('.sable-unread-badge-count')?.textContent).toBe('3');
  expect(beta?.querySelector('.sable-unread-badge-count')).toBeNull();
  expect(beta?.querySelector('.sable-unread-badge-dot')).not.toBeNull();

  await unmount(instance);
});

test('outlines every tab but a space avatar', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [space('!a:example.org', 'Alpha')], mobile: true },
  });
  await tick();

  expect(
    document.querySelector('a[href="/home"]')?.classList.contains('sable-nav-tab-outlined')
  ).toBe(true);
  expect(
    document.querySelector('a[aria-label="Alpha"]')?.classList.contains('sable-nav-tab-outlined')
  ).toBe(false);

  await unmount(instance);
});

test('opens a space on its lobby when there is nothing to restore', () => {
  expect(
    spaceNavigationHref(
      '/space/!space%3Aexample.org',
      undefined,
      false,
      '/space/!space%3Aexample.org/lobby'
    )
  ).toBe('/space/!space%3Aexample.org/lobby');
  expect(
    spaceNavigationHref(
      '/space/!space%3Aexample.org',
      '/home/!room%3Aexample.org',
      false,
      '/space/!space%3Aexample.org/lobby'
    )
  ).toBe('/space/!space%3Aexample.org/lobby');
});

test('separates the spaces from the tabs above them, only when there are any', async () => {
  const empty = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [], mobile: true },
  });
  await tick();
  expect(document.querySelector('.rail-separator')).toBeNull();
  await unmount(empty);

  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [space()], mobile: true },
  });
  await tick();
  expect(document.querySelector('.rail-separator')).not.toBeNull();

  await unmount(instance);
});

test('marks a whole section read from the tab that badges it', async () => {
  const marked: string[] = [];
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [],
      directUnread: { unread: 2, highlight: 0 },
      onMarkSectionRead: (section: string) => marked.push(section),
      mobile: true,
    },
  });
  await tick();

  const anchor = document.querySelector('a[href="/direct"]')?.closest('.rail-section-anchor');
  anchor?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();
  await tick();

  const item = [...document.querySelectorAll<HTMLElement>('.sable-menu-item')].find(
    (element) => element.textContent.trim() === 'nav.markSectionRead'
  );
  expect(item).not.toBeUndefined();
  item?.click();
  await tick();

  expect(marked).toEqual(['direct']);

  await unmount(instance);
});

test('restores a space to its last desktop route', () => {
  expect(
    spaceNavigationHref(
      '/space/!space%3Aexample.org',
      '/space/!space%3Aexample.org/!room%3Aexample.org?event=%24event',
      false,
      '/space/!space%3Aexample.org/lobby'
    )
  ).toBe('/space/!space%3Aexample.org/!room%3Aexample.org?event=%24event');
  expect(
    spaceNavigationHref(
      '/space/!space%3Aexample.org',
      '/home/!room%3Aexample.org',
      false,
      '/space/!space%3Aexample.org/lobby'
    )
  ).toBe('/space/!space%3Aexample.org/lobby');
});

test('records the active desktop space route after navigation', async () => {
  const instance = mount(NavigationRail, { target: document.body, props: { spaces: [space()] } });
  await tick();

  pageState.url = {
    pathname: '/space/!space%3Aexample.org/!room%3Aexample.org',
    search: '?event=%24event',
    hash: '#reply',
  };
  navigation.afterNavigate?.();

  expect(savedSpacePaths()).toEqual({
    '!space:example.org': '/space/!space%3Aexample.org/!room%3Aexample.org?event=%24event#reply',
  });

  await unmount(instance);
});

test('opens a space root on mobile even when it has a saved route', async () => {
  localStorage.setItem(
    'sable-space-paths',
    JSON.stringify({ '!space:example.org': '/space/!space%3Aexample.org/!room%3Aexample.org' })
  );
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [space()], mobile: true },
  });
  await tick();

  expect(document.querySelector('[aria-label="Space"]')?.getAttribute('href')).toBe(
    '/space/!space%3Aexample.org'
  );

  await unmount(instance);
});

test('orders spaces by the stored layout and appends unplaced ones', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [space('!a:example.org', 'Alpha'), space('!b:example.org', 'Beta')],
      layout: [{ kind: 'space', room_id: '!b:example.org' }],
      mobile: true,
    },
  });
  await tick();

  expect(
    [...document.querySelectorAll('.rail-slot a')].map((link) => link.getAttribute('aria-label'))
  ).toEqual(['Beta', 'Alpha']);

  await unmount(instance);
});

test('shows a collapsed folder as one tab, with the names of the spaces inside', async () => {
  const toggled: string[] = [];
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [space('!a:example.org', 'Alpha'), space('!b:example.org', 'Beta')],
      layout: [
        { kind: 'folder', id: 'f', name: null, content: ['!a:example.org', '!b:example.org'] },
      ],
      spaceUnread: new Map([['!b:example.org', { unread: 3, highlight: 0 }]]),
      openFolders: new Set<string>(),
      onToggleFolder: (folderId: string) => toggled.push(folderId),
      mobile: true,
    },
  });
  await tick();

  const folder = document.querySelector<HTMLButtonElement>('.folder-preview');
  expect(folder?.getAttribute('aria-label')).toBe('nav.folderExpand:Alpha, Beta');
  expect(folder?.getAttribute('aria-expanded')).toBe('false');
  expect(folder?.querySelectorAll('.folder-tile')).toHaveLength(2);
  expect(folder?.querySelector('.sable-unread-badge-dot')).not.toBeNull();
  expect(document.querySelectorAll('.rail-slot a')).toHaveLength(0);

  folder?.click();
  expect(toggled).toEqual(['f']);

  await unmount(instance);
});

test('shows the spaces of an open folder, and a way to shut it', async () => {
  const toggled: string[] = [];
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [space('!a:example.org', 'Alpha'), space('!b:example.org', 'Beta')],
      layout: [
        { kind: 'folder', id: 'f', name: 'Work', content: ['!a:example.org', '!b:example.org'] },
      ],
      openFolders: new Set(['f']),
      onToggleFolder: (folderId: string) => toggled.push(folderId),
      mobile: true,
    },
  });
  await tick();

  expect(document.querySelector('.folder-preview')).toBeNull();
  expect(
    [...document.querySelectorAll('.folder-open .rail-slot a')].map((link) =>
      link.getAttribute('aria-label')
    )
  ).toEqual(['Alpha', 'Beta']);

  const collapse = document.querySelector<HTMLButtonElement>('.folder-collapse');
  expect(collapse?.getAttribute('aria-label')).toBe('nav.folderCollapse:Work');
  expect(collapse?.getAttribute('aria-expanded')).toBe('true');
  expect(collapse?.classList.contains('sable-open')).toBe(false);
  collapse?.click();
  expect(toggled).toEqual(['f']);

  await unmount(instance);
});

test('a space that left the room list drops out of its folder', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [space('!a:example.org', 'Alpha')],
      layout: [
        { kind: 'folder', id: 'f', name: null, content: ['!a:example.org', '!gone:example.org'] },
      ],
      openFolders: new Set(['f']),
      mobile: true,
    },
  });
  await tick();

  expect(
    [...document.querySelectorAll('.folder-open .rail-slot a')].map((link) =>
      link.getAttribute('aria-label')
    )
  ).toEqual(['Alpha']);

  await unmount(instance);
});

test('offers a way out of a folder holding a single space', async () => {
  const removed: [string, string][] = [];
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [space('!a:example.org', 'Alpha')],
      layout: [{ kind: 'folder', id: 'f', name: null, content: ['!a:example.org'] }],
      openFolders: new Set(['f']),
      onRemoveFromFolder: (roomId: string, folderId: string) => removed.push([roomId, folderId]),
      mobile: true,
    },
  });
  await tick();

  const anchor = document.querySelector('.folder-open .rail-menu-anchor');
  expect(anchor).not.toBeNull();
  anchor?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();
  await tick();

  const item = [...document.querySelectorAll<HTMLElement>('.sable-menu-item')].find(
    (element) => element.textContent.trim() === 'nav.folderRemoveSpace'
  );
  expect(item).not.toBeUndefined();
  item?.click();
  await tick();

  expect(removed).toEqual([['!a:example.org', 'f']]);

  await unmount(instance);
});

test('the mobile rail does not arm dragging', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [space('!a:example.org', 'Alpha')], mobile: true },
  });
  await tick();

  expect(document.querySelector('.rail-slot')?.getAttribute('draggable')).toBeNull();

  await unmount(instance);
});

test('a folder whose spaces are all unresolved renders nothing', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: {
      spaces: [space('!a:example.org', 'Alpha')],
      layout: [
        { kind: 'folder', id: 'f', name: null, content: ['!gone:example.org'] },
        { kind: 'space', room_id: '!a:example.org' },
      ],
      mobile: true,
    },
  });
  await tick();

  expect(document.querySelector('.folder-preview')).toBeNull();
  expect(document.querySelectorAll('.rail-slot a')).toHaveLength(1);

  await unmount(instance);
});

test('right-clicking a top-level space opens its options menu', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [space('!a:example.org', 'Alpha')] },
  });
  await tick();

  const anchor = [...document.querySelectorAll('.rail-menu-anchor')].find((element) =>
    element.querySelector('.rail-slot')
  );
  expect(anchor).not.toBeUndefined();
  anchor?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();
  await tick();

  const labels = [...document.querySelectorAll<HTMLElement>('.sable-menu-item')].map((element) =>
    element.textContent.trim()
  );
  expect(labels).toContain('room.menuMarkRead');
  expect(labels).not.toContain('settings.showUnreadCounts');

  await unmount(instance);
});
