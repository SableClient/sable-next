// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';

const pageState = vi.hoisted(() => ({ url: { pathname: '/home' } }));

vi.mock('$app/state', () => ({ page: pageState }));
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

afterEach(() => {
  document.body.replaceChildren();
});

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
