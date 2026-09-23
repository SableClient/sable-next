import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import type { CoreClient } from '#lib/core/client.svelte.js';
import { InviteActions, isDeclining } from './invites.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

afterEach(() => {
  for (const toast of [...toasts.items]) toasts.dismiss(toast.id);
});

const room = { room_id: '!room:example.org', is_space: false, is_direct: false } as RoomSummary;

function actions(commands: Record<string, unknown>): InviteActions {
  return new InviteActions({ commands } as unknown as CoreClient);
}

test('a join the server rejects raises a toast and releases the room', async () => {
  const answers = actions({ joinRoom: vi.fn(() => Promise.reject(new Error('no via'))) });

  await answers.accept(room);

  expect(toasts.items).toHaveLength(1);
  expect(answers.isAnswering(room.room_id)).toBe(false);
});

test('a decline waits for its undo toast to close before leaving', async () => {
  const leaveRoom = vi.fn(() => Promise.resolve());
  const answers = actions({ leaveRoom });

  answers.decline(room);

  expect(isDeclining(room.room_id)).toBe(true);
  expect(leaveRoom).not.toHaveBeenCalled();

  toasts.dismiss(toasts.items[0]?.id ?? -1);
  await vi.waitFor(() => {
    expect(isDeclining(room.room_id)).toBe(false);
  });
  expect(leaveRoom).toHaveBeenCalledWith(room.room_id);
});

test('undoing a decline never leaves the room', () => {
  const leaveRoom = vi.fn(() => Promise.resolve());
  const answers = actions({ leaveRoom });

  answers.decline(room);
  toasts.items[0]?.action?.run();

  expect(leaveRoom).not.toHaveBeenCalled();
  expect(isDeclining(room.room_id)).toBe(false);
  expect(toasts.items).toEqual([]);
});

test('a decline the server rejects raises a toast and shows the invite again', async () => {
  const answers = actions({ leaveRoom: vi.fn(() => Promise.reject(new Error('gone'))) });

  answers.decline(room);
  toasts.dismiss(toasts.items[0]?.id ?? -1);

  await vi.waitFor(() => {
    expect(toasts.items).toHaveLength(1);
  });
  expect(toasts.items[0]?.tone).toBe('error');
  expect(isDeclining(room.room_id)).toBe(false);
});

test('an accepted invitation raises nothing', async () => {
  const answers = actions({ joinRoom: vi.fn(() => Promise.resolve('!room:example.org')) });

  await answers.accept(room);

  expect(toasts.items).toEqual([]);
});
