// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { adoptQuietRooms } from './quiet-rooms.svelte.js';
import { RoomList } from './room-list.svelte.js';

test('starting from an effect does not tie the effect to the room-list options', async () => {
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [] })),
        setRoomListOptions: vi.fn(() => Promise.resolve()),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);
  let runs = 0;
  const cleanup = $effect.root(() => {
    $effect(() => {
      runs += 1;
      void roomList.start();
      return () => {
        roomList.stop();
      };
    });
  });
  flushSync();
  await vi.waitFor(() => {
    expect(core.rpc.timeline.subscribeRoomList).toHaveBeenCalledOnce();
  });

  adoptQuietRooms(['!quiet:example.org']);
  flushSync();

  expect(runs).toBe(1);
  expect(core.rpc.timeline.unsubscribe).not.toHaveBeenCalled();
  cleanup();
});
