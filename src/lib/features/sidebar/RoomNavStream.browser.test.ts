import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { visit } from '#lib/test-support/app-state.js';
import { roomView } from '#lib/test-support/room-views.js';

const list = vi.hoisted(() => ({ current: null as ReturnType<typeof streamedRoomList> | null }));

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => list.current,
}));
vi.mock('#lib/rooms/presence.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/presence.svelte.js')>()),
  usePresenceStore: () => ({ get: () => null, peek: () => null }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import RoomNavHarness from './RoomNavHarness.test.svelte';
import { streamedRoomList } from './room-list-fixture.test.svelte.js';

const dm = (index: number) =>
  roomView({
    room_id: `!r${String(index)}:example.org`,
    name: `Room ${String(index)}`,
    is_direct: true,
    latest_event: {
      sender: null,
      own: false,
      sender_label: null,
      kind: 'text',
      body: 'hi',
      emotes: [],
      timestamp: 1,
      sending: false,
      event_id: null,
    },
  });

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame++) {
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  }
}

async function mountDirect(count: number) {
  visit('/direct');
  const rooms = streamedRoomList();
  rooms.rooms = Array.from({ length: count }, (_, index) => dm(index));
  list.current = rooms;
  Object.assign(core.rpc.notifications, {
    settings: vi.fn().mockResolvedValue({ mode: 'all', default: 'all' }),
  });
  await page.viewport(1280, 900);
  await render(RoomNavHarness, { height: 400 });
  const scroller = document.querySelector<HTMLElement>('.room-nav-content');
  if (!scroller) throw new Error('the room list scroller is not rendered');
  await frames(2);
  return { rooms, scroller };
}

async function firstVisibleRow(scroller: HTMLElement) {
  scroller.scrollTop = 2000;
  await frames(3);
  const row = [...document.querySelectorAll<HTMLElement>('.room-list [data-row-key]')].find(
    (candidate) => candidate.getBoundingClientRect().top >= scroller.getBoundingClientRect().top
  );
  if (!row?.dataset.rowKey) throw new Error('no row is visible');
  const key = row.dataset.rowKey;
  const top = () =>
    document.querySelector(`[data-row-key="${key}"]`)?.getBoundingClientRect().top ?? NaN;
  return { before: top(), top };
}

test('rooms streamed in above the viewport leave the visible rooms in place', async () => {
  const { rooms, scroller } = await mountDirect(300);
  const { before, top } = await firstVisibleRow(scroller);

  for (let batch = 0; batch < 5; batch++) {
    rooms.rooms = [
      ...Array.from({ length: 10 }, (_, offset) => dm(1000 + batch * 10 + offset)),
      ...rooms.rooms,
    ];
    await frames(2);
  }

  expect(Math.abs(top() - before)).toBeLessThan(1);
});

test('a room moving to the top of a scrolled list leaves the visible rooms in place', async () => {
  const { rooms, scroller } = await mountDirect(300);
  const { before, top } = await firstVisibleRow(scroller);

  rooms.rooms = [...rooms.rooms.slice(-1), ...rooms.rooms.slice(0, -1)];
  await frames(2);

  expect(Math.abs(top() - before)).toBeLessThan(1);
});

test('at the top of the list a new room appears above the others', async () => {
  const { rooms, scroller } = await mountDirect(50);

  rooms.rooms = [dm(999), ...rooms.rooms];
  await frames(2);

  expect(scroller.scrollTop).toBe(0);
  expect(document.querySelector('[data-row-key="!r999:example.org"]')).not.toBeNull();
});
