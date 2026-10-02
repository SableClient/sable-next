import type { RoomSummary } from '#src/generated/protocol';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ back: vi.fn() }));

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import { afterNavigate, goto } from '#lib/test-support/app-navigation.js';
import { page, visit } from '#lib/test-support/app-state.js';
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Partial<Record<string, string>> = {}) =>
    path.replace('/(app)', '').replace('[spaceId]', params.spaceId ?? ''),
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParamFromId: (roomId: string) => `param:${roomId}`,
  findRoomByPathId: (rooms: readonly RoomSummary[], pathId: string | undefined) =>
    rooms.find((room) => room.room_id === pathId),
}));

import {
  backToRoomList,
  contextSearchPath,
  leaveRoomView,
  scopedSearchPath,
  searchInRoom,
  trackRoomEntry,
} from './room-navigation';

beforeEach(() => {
  visit('/rooms/room');
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  mocks.back.mockClear();
  vi.stubGlobal('history', { back: mocks.back });
});

function enter(from: string | null, type = 'link', delta?: number): void {
  afterNavigate.mockClear();
  trackRoomEntry();
  const callback = afterNavigate.mock.calls[0]?.[0] as (navigation: unknown) => void;
  callback({ from: from ? { url: new URL(`https://app.test${from}`) } : null, type, delta });
}

test.each([
  ['/direct/room', {}, 'direct'],
  ['/space/space/room', { spaceId: '!space' }, '/space/param:!space'],
  ['/space/space/room', {}, '/rooms'],
  ['/rooms/room', {}, '/rooms'],
])('leaving %s returns to its section', async (pathname, params, expected) => {
  page.url = new URL(`https://app.test${pathname}`);
  page.params = params;

  await leaveRoomView();

  expect(goto).toHaveBeenCalledWith(expected);
});

test('leaving a space room on desktop opens the lobby rather than the index', async () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
  page.url = new URL('https://app.test/space/space/room');
  page.params = { spaceId: '!space' };

  await leaveRoomView();

  expect(goto).toHaveBeenCalledWith('/space/param:!space/lobby');
});

test('searching quotes a room label with a space in it', () => {
  searchInRoom({ canonical_alias: null, name: 'My room' } as RoomSummary, '!room');

  expect(goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:"My room" ')}`);
});

test('searching an unknown room scopes by its id', () => {
  searchInRoom(undefined, '!room');

  expect(goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:!room ')}`);
});

test('a space search path scopes by the space alias', () => {
  expect(
    scopedSearchPath(
      'space',
      { canonical_alias: '#eng:example.org', name: 'Eng' } as RoomSummary,
      '!eng'
    )
  ).toBe(`/search?q=${encodeURIComponent('space:#eng:example.org ')}`);
});

test('searching from a room scopes to it, from a space to the space, and elsewhere to nothing', () => {
  const rooms = [
    { room_id: '!room', canonical_alias: '#dev:example.org', name: 'Dev' },
    { room_id: '!space', canonical_alias: null, name: 'Eng' },
  ] as RoomSummary[];

  expect(contextSearchPath(rooms, '!room', '!space')).toBe(
    `/search?q=${encodeURIComponent('in:#dev:example.org ')}`
  );
  expect(contextSearchPath(rooms, undefined, '!space')).toBe(
    `/search?q=${encodeURIComponent('space:Eng ')}`
  );
  expect(contextSearchPath(rooms, undefined, undefined)).toBe('/search');
});

test('a room opened from its list goes back through history, so the back gesture animates', async () => {
  page.url = new URL('https://app.test/rooms/room');
  enter('/rooms');

  await leaveRoomView();

  expect(mocks.back).toHaveBeenCalledOnce();
  expect(goto).not.toHaveBeenCalled();
});

test('a room reached by going back, or from elsewhere, navigates to its list', async () => {
  page.url = new URL('https://app.test/rooms/room');
  enter('/rooms', 'popstate', -1);
  await leaveRoomView();
  enter('/search');
  await leaveRoomView();

  expect(mocks.back).not.toHaveBeenCalled();
  expect(goto).toHaveBeenCalledTimes(2);
});

test('the back arrow on a phone opens the drawer over the room rather than leaving it', () => {
  page.url = new URL('https://app.test/rooms/room');
  enter('/rooms');

  backToRoomList();

  expect(mocks.back).not.toHaveBeenCalled();
  expect(goto).toHaveBeenCalledExactlyOnceWith('', {
    shallow: true,
    replace: true,
    state: { mobileDrawer: 'open' },
  });
});

test('the back arrow on a phone pops a room entered from its list', () => {
  page.state.mobileDrawerBack = true;

  backToRoomList();

  expect(mocks.back).toHaveBeenCalledOnce();
  expect(goto).not.toHaveBeenCalled();
});
