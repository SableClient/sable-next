// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';

const pageState = vi.hoisted(() => ({ url: { pathname: '/home' } }));

vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/paths', () => ({
  resolve: (path: string) => (path.startsWith('/') ? path : `/${path}`),
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
