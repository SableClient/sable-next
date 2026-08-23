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
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParam: (room: RoomSummary) => encodeURIComponent(room.room_id),
}));
vi.mock('#lib/ui/primitives/Tooltip.svelte', () => ({ default: () => null }));

import NavigationRail from './NavigationRail.svelte';
import { savedSpacePaths, spaceNavigationHref } from './space-paths.js';

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function space(): RoomSummary {
  return {
    room_id: '!space:example.org',
    canonical_alias: null,
    name: 'Space',
    topic: null,
    avatar_url: null,
    is_direct: false,
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: true,
    is_voice: false,
    call_participants: [],
    has_space_parent: false,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    highlight: 0,
    latest_event: null,
  };
}

test('badges home mentions and unread direct chats', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [], homeUnread: 2, homeHighlight: true, directUnread: 3, mobile: true },
  });
  await tick();

  expect(document.querySelector('a[href="/home"] .unread-count')?.textContent).toBe('2');
  expect(document.querySelector('a[href="/direct"] .unread-count')?.textContent).toBe('3');

  await unmount(instance);
});

test('uses a dot for ordinary home unread messages', async () => {
  const instance = mount(NavigationRail, {
    target: document.body,
    props: { spaces: [], homeUnread: 2, mobile: true },
  });
  await tick();

  expect(document.querySelector('a[href="/home"] .unread-dot')).not.toBeNull();
  expect(document.querySelector('a[href="/home"] .unread-count')).toBeNull();

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
    join_rule: 'invite' as const,
    tags: [],
    state: 'joined' as const,
    encrypted: null,
    is_space: false,
    is_voice: false,
    call_participants: [],
    has_space_parent: false,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 2,
    highlight: 0,
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
  expect(directLink?.querySelector('.unread-count')?.textContent).toBe('2');

  await unmount(instance);
});

test('restores a space to its last desktop route', () => {
  expect(
    spaceNavigationHref(
      '/space/!space%3Aexample.org',
      '/space/!space%3Aexample.org/!room%3Aexample.org?event=%24event',
      false
    )
  ).toBe('/space/!space%3Aexample.org/!room%3Aexample.org?event=%24event');
  expect(
    spaceNavigationHref('/space/!space%3Aexample.org', '/home/!room%3Aexample.org', false)
  ).toBe('/space/!space%3Aexample.org');
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
