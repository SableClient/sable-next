// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

const mounted = vi.hoisted(() => [] as string[]);

vi.mock('$app/state', () => {
  let roomId = $state('!a:example.org');
  return {
    page: {
      url: new URL('http://localhost/rooms/!a:example.org'),
      state: {},
      get params() {
        return { roomId };
      },
    },
    open(id: string) {
      roomId = id;
    },
  };
});
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => ({
    rooms: [
      { room_id: '!a:example.org', state: 'joined' },
      { room_id: '!b:example.org', state: 'joined' },
    ] as RoomListItemView[],
    settled: true,
  }),
}));
vi.mock('./RoomView.svelte', () => ({
  default: (_anchor: unknown, props: { roomId: string }) => {
    mounted.push(props.roomId);
  },
}));

import * as appState from '$app/state';

import RoomPage from './RoomPage.svelte';

test('on the app layout a room switch keeps the same room view', () => {
  render(RoomPage);
  expect(mounted).toEqual(['!a:example.org']);

  (appState as unknown as { open: (id: string) => void }).open('!b:example.org');
  flushSync();

  expect(mounted).toEqual(['!a:example.org']);
});
