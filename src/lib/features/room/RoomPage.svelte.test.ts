// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

const pageState = vi.hoisted(() => ({
  params: { roomId: '!old:example.org' } as Record<string, string>,
  url: new URL('https://app.test/rooms/!old:example.org?via=example.org'),
}));
const rendered = vi.hoisted(() => [] as { kind: string; roomId: string; extra: unknown }[]);

vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => ({ rooms: [], start: () => Promise.resolve() }),
}));
vi.mock('./RoomView.svelte', () => ({
  default: (_anchor: unknown, props: { roomId: string; room?: unknown }) => {
    rendered.push({ kind: 'view', roomId: props.roomId, extra: props.room });
  },
}));
vi.mock('./JoinBeforeNavigate.svelte', () => ({
  default: (_anchor: unknown, props: { roomId: string; via: string[] }) => {
    rendered.push({ kind: 'join', roomId: props.roomId, extra: props.via });
  },
}));

import { core } from '#lib/core/__mocks__/context.js';

import RoomPage from './RoomPage.svelte';

afterEach(() => {
  rendered.length = 0;
  document.body.replaceChildren();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await tick();
  }
}

test('a joined room the list filters out still opens', async () => {
  const room = { room_id: '!old:example.org', state: 'joined' } as RoomSummary;
  const roomSummary = vi.fn(() => Promise.resolve(room));
  Object.assign(core, { roomSummary });
  const instance = mount(RoomPage, { target: document.body });
  await settle();

  expect(roomSummary).toHaveBeenCalledWith('!old:example.org');
  expect(rendered.at(-1)).toEqual({ kind: 'view', roomId: '!old:example.org', extra: room });
  await unmount(instance);
});

test('a room we are not in goes through the join, with its via', async () => {
  Object.assign(core, { roomSummary: vi.fn(() => Promise.reject(new Error('unknown_room'))) });
  const instance = mount(RoomPage, { target: document.body });
  await settle();

  expect(rendered.at(-1)).toEqual({
    kind: 'join',
    roomId: '!old:example.org',
    extra: ['example.org'],
  });
  await unmount(instance);
});

test('a room we left goes through the join', async () => {
  const room = { room_id: '!old:example.org', state: 'left' } as RoomSummary;
  Object.assign(core, { roomSummary: vi.fn(() => Promise.resolve(room)) });
  const instance = mount(RoomPage, { target: document.body });
  await settle();

  expect(rendered.at(-1)?.kind).toBe('join');
  await unmount(instance);
});
