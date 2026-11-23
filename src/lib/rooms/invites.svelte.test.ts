import { afterEach, expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { goto } from '#lib/test-support/app-navigation.js';
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string> = {}) =>
    path.replace('/(app)', '').replace(/\[(\w+)\]/g, (_, key: string) => params[key] ?? key),
}));

import type { CoreClient } from '#lib/core/client.svelte.js';
import { roomView, spaceChild } from '#lib/test-support/room-views.js';
import { InviteActions, isDeclining } from './invites.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

afterEach(() => {
  for (const toast of [...toasts.items]) toasts.dismiss(toast.id);
});

const room = {
  room_id: '!room:example.org',
  room_kind: 'text',
  is_direct: false,
} as RoomListItemView;

function actions(
  commands: Record<string, unknown>,
  rooms: readonly RoomListItemView[] = []
): InviteActions {
  return new InviteActions({ commands, rpc: { rooms: commands } } as unknown as CoreClient, {
    rooms,
  });
}

test('a join the server rejects raises a toast and releases the room', async () => {
  const answers = actions({ join: vi.fn(() => Promise.reject(new Error('no via'))) });

  await answers.accept(room);

  expect(toasts.items).toHaveLength(1);
  expect(answers.isAnswering(room.room_id)).toBe(false);
});

test('a decline waits for its undo toast to close before leaving', async () => {
  const leaveRoom = vi.fn(() => Promise.resolve());
  const answers = actions({ leave: leaveRoom });

  answers.decline(room);

  expect(isDeclining(room.room_id)).toBe(true);
  expect(leaveRoom).not.toHaveBeenCalled();

  toasts.dismiss(toasts.items[0]?.id ?? -1);
  await vi.waitFor(() => {
    expect(isDeclining(room.room_id)).toBe(false);
  });
  expect(leaveRoom).toHaveBeenCalledWith({ room_id: room.room_id });
});

test('undoing a decline never leaves the room', () => {
  const leaveRoom = vi.fn(() => Promise.resolve());
  const answers = actions({ leave: leaveRoom });

  answers.decline(room);
  toasts.items[0]?.action?.run();

  expect(leaveRoom).not.toHaveBeenCalled();
  expect(isDeclining(room.room_id)).toBe(false);
  expect(toasts.items).toEqual([]);
});

test('a decline the server rejects raises a toast and shows the invite again', async () => {
  const answers = actions({ leave: vi.fn(() => Promise.reject(new Error('gone'))) });

  answers.decline(room);
  toasts.dismiss(toasts.items[0]?.id ?? -1);

  await vi.waitFor(() => {
    expect(toasts.items).toHaveLength(1);
  });
  expect(toasts.items[0]?.tone).toBe('error');
  expect(isDeclining(room.room_id)).toBe(false);
});

test('an accepted invitation raises nothing', async () => {
  const answers = actions({ join: vi.fn(() => Promise.resolve('!room:example.org')) });

  await answers.accept(room);

  expect(toasts.items).toEqual([]);
});

test('an accepted invitation opens where the room list files the room', async () => {
  const space = roomView({
    room_id: '!space:example.org',
    room_kind: 'space',
    space_children: [spaceChild({ room_id: room.room_id, via: ['example.org'] })],
  });
  const answers = actions({ join: vi.fn(() => Promise.resolve(room.room_id)) }, [space, room]);
  goto.mockClear();

  await answers.accept(room);

  expect(goto).toHaveBeenCalledWith('/space/!space%3Aexample.org/!room%3Aexample.org');
});

test('an accepted space invitation opens the space, which picks its own page', async () => {
  const space = { ...room, room_id: '!space:example.org', room_kind: 'space' } as RoomListItemView;
  const answers = actions({ join: vi.fn(() => Promise.resolve(space.room_id)) }, [space]);
  goto.mockClear();

  await answers.accept(space);

  expect(goto).toHaveBeenCalledWith('/space/!space%3Aexample.org');
});

test('accepting all joins every invite without leaving the page and reports failures once', async () => {
  const other = { ...room, room_id: '!other:example.org' };
  const third = { ...room, room_id: '!third:example.org' };
  const joinRoom = vi.fn(({ address }: { address: string }) =>
    address === room.room_id ? Promise.resolve(address) : Promise.reject(new Error('no via'))
  );
  const answers = actions({ join: joinRoom });
  goto.mockClear();

  await answers.acceptAll([room, other, third]);

  expect(joinRoom.mock.calls.map(([params]) => params.address)).toEqual([
    room.room_id,
    other.room_id,
    third.room_id,
  ]);
  expect(goto).not.toHaveBeenCalled();
  expect(toasts.items).toHaveLength(1);
  expect(toasts.items[0]?.tone).toBe('error');
  expect(answers.isAnswering(other.room_id)).toBe(false);
});
