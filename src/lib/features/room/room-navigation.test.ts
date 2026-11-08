import type { RoomListItemView } from '#src/generated/protocol';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ back: vi.fn() }));

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
import { afterNavigate, goto } from '#lib/test-support/app-navigation.js';
import { page, visit } from '#lib/test-support/app-state.js';
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Partial<Record<string, string>> = {}) =>
    path.replace('/(app)', '').replace('[spaceId]', params.spaceId ?? ''),
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParamFromId: (roomId: string) => `param:${roomId}`,
  findRoomByPathId: (rooms: readonly RoomListItemView[], pathId: string | undefined) =>
    rooms.find((room) => room.room_id === pathId),
}));

import {
  backToRoomList,
  contextSearchPath,
  goToPage,
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
  ['/home/room', {}, '/home'],
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
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: query === BREAKPOINTS.wide }),
  });
  page.url = new URL('https://app.test/space/space/room');
  page.params = { spaceId: '!space' };

  await leaveRoomView();

  expect(goto).toHaveBeenCalledWith('/space/param:!space/lobby');
});

test('searching quotes a room label with a space in it', () => {
  searchInRoom({ canonical_alias: null, name: 'My room' } as RoomListItemView, '!room');

  expect(goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:"My room" ')}`);
});

test('a failed search navigation does not force a page load', async () => {
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { assign } });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.mocked(goto).mockRejectedValueOnce(new Error('offline'));

  searchInRoom(undefined, '!room');
  await Promise.resolve();

  expect(assign).not.toHaveBeenCalled();
});

test('searching an unknown room scopes by its id', () => {
  searchInRoom(undefined, '!room');

  expect(goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:!room ')}`);
});

test('a space search path scopes by the space alias', () => {
  expect(
    scopedSearchPath(
      'space',
      { canonical_alias: '#eng:example.org', name: 'Eng' } as RoomListItemView,
      '!eng'
    )
  ).toBe(`/search?q=${encodeURIComponent('space:#eng:example.org ')}`);
});

test('searching from a room scopes to it, from a space to the space, and elsewhere to nothing', () => {
  const rooms = [
    { room_id: '!room', canonical_alias: '#dev:example.org', name: 'Dev' },
    { room_id: '!space', canonical_alias: null, name: 'Eng' },
  ] as RoomListItemView[];

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
    state: { mobileDrawer: 'open', mobileDrawerBack: false },
    persistState: true,
  });
});

test.each(['/space/space/lobby', '/rooms'])('on a phone, opening %s from a room pushes', (href) => {
  page.url = new URL('https://app.test/rooms/room');
  page.params = { roomId: 'room' };

  goToPage(href);

  expect(goto).toHaveBeenLastCalledWith(href, { replace: false, state: {}, persistState: true });
});

test.each([
  ['/rooms', {}, '/rooms/room'],
  ['/direct', {}, '/direct/room'],
  ['/space/space', {}, '/space/space/room'],
  ['/space/space/lobby', { mobileDrawer: 'open' as const }, '/space/space/room'],
])('on a phone, opening a room from %s keeps it behind the drawer', async (from, state, href) => {
  visit(from);
  Object.assign(page.state, state);
  goto.mockImplementationOnce((path, options) => {
    visit(path, { roomId: 'room' });
    Object.assign(page.state, options?.state);
    return Promise.resolve();
  });

  goToPage(href);
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledTimes(2);
  });

  expect(goto).toHaveBeenNthCalledWith(1, href, {
    replace: false,
    state: { mobileDrawer: 'open' },
    persistState: true,
  });
  expect(goto).toHaveBeenNthCalledWith(2, '', {
    shallow: true,
    replace: false,
    state: { mobileDrawer: 'closed', mobileDrawerBack: true },
    persistState: true,
  });
});

test.each([
  ['the drawer over a room', { mobileDrawer: 'open' as const }, '/home/room'],
  ['the drawer over a room', { mobileDrawer: 'open' as const }, '/rooms/room'],
  ['the drawer over a room', { mobileDrawer: 'open' as const }, '/direct/room'],
  ['the drawer over a room', { mobileDrawer: 'open' as const }, '/space/space/room'],
  ['a room above the list', { mobileDrawerBack: true }, '/rooms/room'],
  ['a room with no list behind it', {}, '/direct/room'],
])('switching rooms from %s points the list entry at %s', async (_from, state, href) => {
  visit('/space/space/previous', { spaceId: 'space', roomId: 'previous' });
  Object.assign(page.state, state);
  goto.mockImplementationOnce((path, options) => {
    visit(path, { roomId: 'room' });
    Object.assign(page.state, options?.state);
    return Promise.resolve();
  });

  goToPage(href);
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledTimes(2);
  });

  expect(goto).toHaveBeenNthCalledWith(1, href, {
    replace: true,
    state: { mobileDrawer: 'open' },
    persistState: true,
  });
  expect(goto).toHaveBeenNthCalledWith(2, '', {
    shallow: true,
    replace: false,
    state: { mobileDrawer: 'closed', mobileDrawerBack: true },
    persistState: true,
  });
});

test('a room switch that is superseded leaves the drawer alone', async () => {
  visit('/rooms/previous', { roomId: 'previous' });
  page.state.mobileDrawer = 'open';
  goto.mockImplementationOnce(() => {
    visit('/rooms/elsewhere', { roomId: 'elsewhere' });
    return Promise.resolve();
  });

  goToPage('/rooms/other');
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledOnce();
  });
  await Promise.resolve();

  expect(goto).toHaveBeenCalledOnce();
});

test('opening the current room preserves the list entry', () => {
  page.state.mobileDrawer = 'open';
  page.state.overlay = 0;

  goToPage('/rooms/room');

  expect(goto).toHaveBeenCalledExactlyOnceWith('', {
    shallow: true,
    replace: false,
    state: { mobileDrawer: 'closed', mobileDrawerBack: true, overlay: 0 },
    persistState: true,
  });
});

test('the back arrow reuses the list entry', () => {
  page.state.mobileDrawerBack = true;

  backToRoomList();

  expect(mocks.back).toHaveBeenCalledOnce();
  expect(goto).not.toHaveBeenCalled();
});
