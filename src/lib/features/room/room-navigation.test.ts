import type { RoomSummary } from '#src/generated/protocol';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const params: Partial<Record<string, string>> = {};
  return {
    goto: vi.fn<(target: string) => Promise<void>>(() => Promise.resolve()),
    page: { url: new URL('https://app.test/rooms/room'), params },
  };
});

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/state', () => ({ page: mocks.page }));
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Partial<Record<string, string>> = {}) =>
    path.replace('/(app)', '').replace('[spaceId]', params.spaceId ?? ''),
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParamFromId: (roomId: string) => `param:${roomId}`,
}));

import { leaveRoomView, searchInRoom } from './room-navigation';

beforeEach(() => {
  mocks.goto.mockClear();
  mocks.page.params = {};
});

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

test('searching quotes a room label with a space in it', () => {
  searchInRoom({ canonical_alias: null, name: 'My room' } as RoomSummary, '!room');

  expect(mocks.goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:"My room" ')}`);
});

test('searching an unknown room scopes by its id', () => {
  searchInRoom(undefined, '!room');

  expect(mocks.goto).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('in:!room ')}`);
});
