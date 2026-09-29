// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick, type ComponentProps } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { visit } from '#lib/test-support/app-state.js';
import { navigated } from '#lib/test-support/app-navigation.js';
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
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParam: (room: RoomSummary) => encodeURIComponent(room.room_id),
  useRoomList: () => ({ rooms: [], quietRoomIds: new Set() }),
}));
vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

core.roomPermissions.mockResolvedValue({ can_manage_children: false });

import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

import NavigationRail from './NavigationRail.svelte';
import { LONG_PRESS_MS } from '#lib/ui/long-press.svelte.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { savedSpacePaths, spaceNavigationHref } from './space-paths.js';

beforeEach(() => {
  visit('/home');
});

afterEach(() => {
  localStorage.clear();
  setPreference('showSearch', true);
});

function renderRail(
  options: ComponentProps<typeof NavigationRail> | { props: ComponentProps<typeof NavigationRail> }
) {
  return render(NavigationRail, options, { wrapper: TooltipProvider });
}
const user = userEvent.setup();
const tab = (name: string) => screen.getByRole('link', { name });
const linkTo = (href: string) =>
  screen.queryAllByRole('link').find((link) => link.getAttribute('href') === href) ?? null;
const spaceOrder = () =>
  [...document.querySelectorAll('.rail-slot a')].map((link) => link.getAttribute('aria-label'));

async function openMenu(target: Element): Promise<HTMLElement[]> {
  await user.pointer({ keys: '[MouseRight]', target });
  await vi.waitFor(() => {
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  });
  return screen.getAllByRole('menuitem');
}

const labels = (items: HTMLElement[]) => items.map((item) => item.textContent.trim());

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

test('badges unread direct chats', async () => {
  renderRail({
    props: {
      spaces: [],
      directUnread: { unread: 3, highlight: 3 },
      mobile: true,
    },
  });
  await tick();

  expect(within(tab('nav.direct')).getByText('3').closest('.unread-badge')).toHaveClass(
    'unread-badge-count'
  );
  expect(tab('nav.direct')).toHaveAccessibleDescription('nav.unreadMentions:3');
});

test('badges the unspaced section', async () => {
  renderRail({
    props: {
      spaces: [],
      unspacedUnread: { unread: 4, highlight: 2 },
      mobile: true,
    },
  });
  await tick();

  expect(within(tab('nav.unspaced')).getByText('2').closest('.unread-badge')).toHaveClass(
    'unread-badge-count'
  );
});

test('search leaves the rail when the preference is off', async () => {
  renderRail({ spaces: [], mobile: true });
  await tick();

  expect(tab('search.title')).toHaveAttribute('href', '/search');

  setPreference('showSearch', false);
  await tick();

  expect(screen.queryByRole('link', { name: 'search.title' })).not.toBeInTheDocument();
});

test('uses a dot for ordinary unread messages outside spaces', async () => {
  renderRail({ spaces: [], unspacedUnread: { unread: 2, highlight: 0 }, mobile: true });
  await tick();

  expect(tab('nav.unspaced').querySelector('.unread-badge-dot')).toBeInTheDocument();
  expect(tab('nav.unspaced').querySelector('.unread-badge-count')).not.toBeInTheDocument();
  expect(tab('nav.unspaced')).toHaveAccessibleDescription('nav.unreadMessages:2');
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
    room_type: null,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 2,
    notifying: 2,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
  } satisfies RoomSummary;
  renderRail({ spaces: [], directRooms: [directRoom], mobile: true });
  await tick();

  const directLink = tab('Alice');
  expect(directLink).toHaveAttribute('href', '/direct/!dm%3Aexample.org');
  expect(directLink.querySelector('.space-initial')).toHaveTextContent('A');
  expect(within(directLink).getByText('2').closest('.unread-badge')).toHaveClass(
    'unread-badge-count'
  );
  expect(directLink.querySelector('.unread-badge-dot')).not.toBeInTheDocument();
});

test('badges a space with its mentions and dots one with only unread messages', async () => {
  renderRail({
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

  expect(within(tab('Alpha')).getByText('3').closest('.unread-badge')).toHaveClass(
    'unread-badge-count'
  );
  expect(tab('Beta').querySelector('.unread-badge-count')).not.toBeInTheDocument();
  expect(tab('Beta').querySelector('.unread-badge-dot')).toBeInTheDocument();
  expect(tab('Beta')).toHaveAccessibleDescription('nav.unreadMessages:4');
  expect(tab('nav.unspaced')).toHaveAccessibleDescription('');
});

test('outlines every tab but a space avatar', async () => {
  renderRail({ spaces: [space('!a:example.org', 'Alpha')], mobile: true });
  await tick();

  expect(tab('nav.unspaced')).toHaveClass('nav-tab-outlined');
  expect(tab('Alpha')).not.toHaveClass('nav-tab-outlined');
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
  const empty = renderRail({ spaces: [], mobile: true });
  await tick();
  expect(document.querySelector('.rail-separator')).toBeNull();
  empty.unmount();

  renderRail({ spaces: [space()], mobile: true });
  await tick();
  expect(document.querySelector('.rail-separator')).not.toBeNull();
});

test('marks a whole section read from the tab that badges it', async () => {
  const marked: string[] = [];
  renderRail({
    props: {
      spaces: [],
      directUnread: { unread: 2, highlight: 0 },
      onMarkSectionRead: (section: string) => marked.push(section),
      mobile: true,
    },
  });
  await tick();

  await openMenu(tab('nav.direct'));
  await user.click(screen.getByRole('menuitem', { name: 'nav.markSectionRead' }));

  expect(marked).toEqual(['direct']);
});

test('marks the rooms outside spaces read from their tab', async () => {
  const marked: string[] = [];
  renderRail({
    props: {
      spaces: [],
      unspacedUnread: { unread: 2, highlight: 0 },
      onMarkSectionRead: (section: string) => marked.push(section),
      mobile: true,
    },
  });
  await tick();

  await openMenu(tab('nav.unspaced'));
  await user.click(screen.getByRole('menuitem', { name: 'nav.markSectionRead' }));

  expect(marked).toEqual(['unspaced']);
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

test('records the active desktop space route without its event anchor', async () => {
  renderRail({ spaces: [space()] });
  await tick();

  visit('/space/!space%3Aexample.org/!room%3Aexample.org?event=%24event&via=example.org#reply');
  navigated();

  expect(savedSpacePaths()).toEqual({
    '!space:example.org': '/space/!space%3Aexample.org/!room%3Aexample.org?via=example.org#reply',
  });
});

test('opens a space root on mobile even when it has a saved route', async () => {
  localStorage.setItem(
    'sable-space-paths',
    JSON.stringify({ '!space:example.org': '/space/!space%3Aexample.org/!room%3Aexample.org' })
  );
  renderRail({ spaces: [space()], mobile: true });
  await tick();

  expect(tab('Space')).toHaveAttribute('href', '/space/!space%3Aexample.org');
});

test('orders spaces by the stored layout and appends unplaced ones', async () => {
  renderRail({
    props: {
      spaces: [space('!a:example.org', 'Alpha'), space('!b:example.org', 'Beta')],
      layout: [{ kind: 'space', room_id: '!b:example.org' }],
      mobile: true,
    },
  });
  await tick();

  expect(spaceOrder()).toEqual(['Beta', 'Alpha']);
});

test('shows a collapsed folder as one tab, with the names of the spaces inside', async () => {
  const toggled: string[] = [];
  renderRail({
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

  const folder = screen.getByRole('button', { name: 'nav.folderExpand:Alpha, Beta' });
  expect(folder).toHaveAttribute('aria-expanded', 'false');
  expect(folder.querySelectorAll('.folder-tile')).toHaveLength(2);
  expect(folder.querySelector('.unread-badge-dot')).toBeInTheDocument();
  expect(folder).toHaveAccessibleDescription('nav.unreadMessages:3');
  expect(screen.queryByRole('link', { name: 'Alpha' })).not.toBeInTheDocument();

  await user.click(folder);
  expect(toggled).toEqual(['f']);
});

test('shows the spaces of an open folder, and a way to shut it', async () => {
  const toggled: string[] = [];
  renderRail({
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

  expect(screen.queryByRole('button', { name: /^nav\.folderExpand/ })).not.toBeInTheDocument();
  expect(spaceOrder()).toEqual(['Alpha', 'Beta']);

  const collapse = screen.getByRole('button', { name: 'nav.folderCollapse:Work' });
  expect(collapse).toHaveAttribute('aria-expanded', 'true');
  expect(collapse).not.toHaveClass('selection-open');
  await user.click(collapse);
  expect(toggled).toEqual(['f']);
});

test('a space that left the room list drops out of its folder', async () => {
  renderRail({
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

  expect(spaceOrder()).toEqual(['Alpha']);
});

test('offers a way out of a folder holding a single space', async () => {
  const removed: [string, string][] = [];
  renderRail({
    props: {
      spaces: [space('!a:example.org', 'Alpha')],
      layout: [{ kind: 'folder', id: 'f', name: null, content: ['!a:example.org'] }],
      openFolders: new Set(['f']),
      onRemoveFromFolder: (roomId: string, folderId: string) => removed.push([roomId, folderId]),
      mobile: true,
    },
  });
  await tick();

  await openMenu(tab('Alpha'));
  await user.click(screen.getByRole('menuitem', { name: 'nav.folderRemoveSpace' }));

  expect(removed).toEqual([['!a:example.org', 'f']]);
});

test('the mobile rail does not arm dragging', async () => {
  renderRail({ spaces: [space('!a:example.org', 'Alpha')], mobile: true });
  await tick();

  expect(tab('Alpha').closest('.rail-slot')).not.toHaveAttribute('draggable');
});

test('a folder whose spaces are all unresolved renders nothing', async () => {
  renderRail({
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

  expect(screen.queryByRole('button', { name: /^nav\.folderExpand/ })).not.toBeInTheDocument();
  expect(spaceOrder()).toEqual(['Alpha']);
});

test('right-clicking a top-level space opens its options menu', async () => {
  renderRail({ spaces: [space('!a:example.org', 'Alpha')] });
  await tick();

  const items = labels(await openMenu(tab('Alpha')));
  expect(items).toContain('room.menuMarkRead');
  expect(items).not.toContain('settings.showUnreadCounts');
});

test.each([
  ['a pinned subspace', true],
  ['a top-level space', false],
])('%s offers unpinning from its options menu only when pinned', async (_, pinned) => {
  const onUnpin = vi.fn();
  renderRail({
    props: {
      spaces: [space('!a:example.org', 'Alpha')],
      pinnedSpaceIds: new Set(pinned ? ['!a:example.org'] : []),
      onUnpin,
    },
  });
  await tick();

  await openMenu(tab('Alpha'));
  const unpin = screen.queryByRole('menuitem', { name: /nav\.unpinFromSidebar/ });
  expect(unpin !== null).toBe(pinned);
  if (unpin) await user.click(unpin);
  await vi.waitFor(() => {
    expect(onUnpin).toHaveBeenCalledTimes(pinned ? 1 : 0);
  });
  if (pinned) expect(onUnpin).toHaveBeenCalledWith('!a:example.org');
});

test('long-pressing a top-level space opens its options menu', async () => {
  vi.useFakeTimers();
  const touch = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  renderRail({ spaces: [space('!a:example.org', 'Alpha')], mobile: true });

  const target = tab('Alpha');
  await touch.pointer({ keys: '[TouchA>]', target, coords: { clientX: 8, clientY: 8 } });
  vi.advanceTimersByTime(LONG_PRESS_MS);
  await touch.pointer({ keys: '[/TouchA]', target });
  vi.advanceTimersByTime(500);
  vi.useRealTimers();

  await vi.waitFor(() => {
    expect(labels(screen.getAllByRole('menuitem'))).toContain('room.menuMarkRead');
  });
});

test('restores the direct tab to its last desktop chat', () => {
  expect(spaceNavigationHref('/direct', '/direct/!dm%3Aexample.org', false, '/direct')).toBe(
    '/direct/!dm%3Aexample.org'
  );
  expect(spaceNavigationHref('/direct', '/home/!room%3Aexample.org', false, '/direct')).toBe(
    '/direct'
  );
});

test('opens the direct root on mobile even when it has a saved chat', async () => {
  localStorage.setItem(
    'sable-space-paths',
    JSON.stringify({ direct: '/direct/!dm%3Aexample.org' })
  );
  renderRail({ spaces: [], mobile: true });
  await tick();

  expect(tab('nav.direct')).toHaveAttribute('href', '/direct');
  expect(linkTo('/direct/!dm%3Aexample.org')).not.toBeInTheDocument();
});

test('records the active desktop direct chat', async () => {
  renderRail({ spaces: [] });
  await tick();

  visit('/direct/!dm%3Aexample.org?event=%24event');
  navigated();

  expect(savedSpacePaths()).toEqual({ direct: '/direct/!dm%3Aexample.org' });
});

test('offers join by address from the add button', async () => {
  const visited: string[] = [];
  renderRail({
    spaces: [],
    mobile: true,
    onNavigate: (href: string) => visited.push(href),
  });
  await tick();

  await user.click(screen.getByRole('button', { name: 'nav.add' }));

  await vi.waitFor(() => {
    expect(labels(screen.getAllByRole('menuitem'))).toEqual([
      'nav.createRoom',
      'nav.createSpace',
      'nav.joinWithAddress',
      'nav.explore',
    ]);
  });

  await user.click(screen.getByRole('menuitem', { name: 'nav.joinWithAddress' }));

  expect(visited).toEqual(['/explore#explore-join-by-address']);
});
