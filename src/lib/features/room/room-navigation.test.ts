import type { RoomSummary } from '#src/generated/protocol';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const params: Partial<Record<string, string>> = {};
  return {
    goto: vi.fn<(target: string) => Promise<void>>(() => Promise.resolve()),
    afterNavigate: vi.fn(),
    back: vi.fn(),
    page: { url: new URL('https://app.test/rooms/room'), params },
  };
});

vi.mock('$app/navigation', () => ({ goto: mocks.goto, afterNavigate: mocks.afterNavigate }));
vi.mock('$app/state', () => ({ page: mocks.page }));
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
  mocks.goto.mockClear();
  mocks.page.params = {};
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  mocks.back.mockClear();
  vi.stubGlobal('history', { back: mocks.back });
});

function enter(from: string | null, type = 'link', delta?: number): void {
  mocks.afterNavigate.mockClear();
  trackRoomEntry();
  const callback = mocks.afterNavigate.mock.calls[0]?.[0] as (navigation: unknown) => void;
  callback({ from: from ? { url: new URL(`https://app.test${from}`) } : null, type, delta });
}

test.each([
  ['/direct/room', {}, 'direct'],
  ['/space/space/room', { spaceId: '!space' }, '/space/param:!space'],
  ['/space/space/room', {}, '/rooms'],
  ['/rooms/room', {}, '/rooms'],
])('leaving %s returns to its section', (pathname, params, expected) => {
  mocks.page.url = new URL(`https://app.test${pathname}`);
  mocks.page.params = params;

  leaveRoomView();

  expect(mocks.goto).toHaveBeenCalledWith(expected);
});

test('leaving a space room on desktop opens the lobby rather than the index', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
  mocks.page.url = new URL('https://app.test/space/space/room');
  mocks.page.params = { spaceId: '!space' };

  leaveRoomView();

  expect(mocks.goto).toHaveBeenCalledWith('/space/param:!space/lobby');
});

test('searching quotes a room label with a space in it', () => {
  searchInRoom({ canonical_alias: null, name: 'My room' } as RoomSummary, '!room');

  expect(mocks.goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:"My room" ')}`);
});

test('searching an unknown room scopes by its id', () => {
  searchInRoom(undefined, '!room');

  expect(mocks.goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:!room ')}`);
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

test('a room opened from its list goes back through history, so the back gesture animates', () => {
  mocks.page.url = new URL('https://app.test/rooms/room');
  enter('/rooms');

  leaveRoomView();

  expect(mocks.back).toHaveBeenCalledOnce();
  expect(mocks.goto).not.toHaveBeenCalled();
});

test('a room reached by going back, or from elsewhere, navigates to its list', () => {
  mocks.page.url = new URL('https://app.test/rooms/room');
  enter('/rooms', 'popstate', -1);
  leaveRoomView();
  enter('/search');
  leaveRoomView();

  expect(mocks.back).not.toHaveBeenCalled();
  expect(mocks.goto).toHaveBeenCalledTimes(2);
});

test('the back arrow on a phone opens the drawer over the room rather than leaving it', () => {
  mocks.page.url = new URL('https://app.test/rooms/room');
  enter('/rooms');

  backToRoomList();

  expect(mocks.back).not.toHaveBeenCalled();
  expect(mocks.goto).toHaveBeenCalledExactlyOnceWith('', {
    shallow: true,
    state: { mobileDrawer: 'open' },
  });
});
