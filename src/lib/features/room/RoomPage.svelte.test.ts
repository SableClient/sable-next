// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

const rendered = vi.hoisted(() => [] as { kind: string; roomId: string; extra: unknown }[]);

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { visit } from '#lib/test-support/app-state.js';
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
vi.mock('./discovery/JoinBeforeNavigate.svelte', () => ({
  default: (_anchor: unknown, props: { roomId: string; via: string[] }) => {
    rendered.push({ kind: 'join', roomId: props.roomId, extra: props.via });
  },
}));

import { core } from '#lib/core/__mocks__/context.js';
import { goto, resetNavigation } from '#lib/test-support/app-navigation.js';

import RoomPage from './RoomPage.svelte';

beforeEach(() => {
  visit('/rooms/!old:example.org?via=example.org', { roomId: '!old:example.org' });
});

afterEach(() => {
  rendered.length = 0;
  resetNavigation();
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
  render(RoomPage);
  await settle();

  expect(roomSummary).toHaveBeenCalledWith('!old:example.org');
  expect(rendered.at(-1)).toEqual({ kind: 'view', roomId: '!old:example.org', extra: room });
});

test('a room we are not in goes through the join, with its via', async () => {
  Object.assign(core, { roomSummary: vi.fn(() => Promise.reject(new Error('unknown_room'))) });
  render(RoomPage);
  await settle();

  expect(rendered.at(-1)).toEqual({
    kind: 'join',
    roomId: '!old:example.org',
    extra: ['example.org'],
  });
});

test('a room we left goes through the join', async () => {
  const room = { room_id: '!old:example.org', state: 'left' } as RoomSummary;
  Object.assign(core, { roomSummary: vi.fn(() => Promise.resolve(room)) });
  render(RoomPage);
  await settle();

  expect(rendered.at(-1)?.kind).toBe('join');
});

test('a space opened as a room is sent to its lobby', async () => {
  const space = { room_id: '!old:example.org', state: 'joined', is_space: true } as RoomSummary;
  Object.assign(core, { roomSummary: vi.fn(() => Promise.resolve(space)) });
  render(RoomPage);
  await settle();

  expect(goto).toHaveBeenCalledWith(expect.stringMatching(/\/space\/.+\/lobby$/), {
    replace: true,
  });
  expect(rendered.at(-1)?.kind).not.toBe('view');
});

test('on the mobile layout the room mounts a frame after the route, behind the drawer slide', async () => {
  const { happyDOM } = window as unknown as {
    happyDOM: { setViewport: (viewport: { width: number }) => void };
  };
  happyDOM.setViewport({ width: 400 });
  const room = { room_id: '!old:example.org', state: 'joined' } as RoomSummary;
  Object.assign(core, { roomSummary: vi.fn(() => Promise.resolve(room)) });
  render(RoomPage);
  await settle();

  expect(rendered.filter((entry) => entry.kind === 'view')).toEqual([]);

  await vi.waitFor(() => {
    expect(rendered.at(-1)).toEqual({ kind: 'view', roomId: '!old:example.org', extra: room });
  });
  happyDOM.setViewport({ width: 1024 });
});
