// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';
import type { CoreEvent, MemberView } from '#src/generated/protocol';
import { refreshRoomMembers } from './room-member-refresh.svelte.js';

function setup(members: Pick<MemberView, 'user_id'>[] = []) {
  let emit!: (event: CoreEvent) => void;
  let profileChanged!: (userId: string) => void;
  const refresh = vi.fn(() => Promise.resolve());
  const core = {
    rpc: { members: { list: vi.fn() } },
    onProfileChanged: (listener: (userId: string) => void) => {
      profileChanged = listener;
      return () => {};
    },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      emit = listener;
      return () => {};
    },
  };
  const cleanup = $effect.root(() => {
    refreshRoomMembers(core as never, { refresh, members } as never, () => '!room:example.org');
  });
  flushSync();
  return {
    emit,
    profileChanged: (userId: string) => {
      profileChanged(userId);
    },
    refresh,
    cleanup,
  };
}

test('refreshes the members of the open room once per burst of membership changes', () => {
  vi.useFakeTimers();
  const { emit, refresh, cleanup } = setup();
  emit({ type: 'members_changed', room_id: '!other:example.org' });
  for (let i = 0; i < 5; i += 1) emit({ type: 'members_changed', room_id: '!room:example.org' });
  expect(refresh).not.toHaveBeenCalled();

  vi.runAllTimers();
  expect(refresh).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledWith('!room:example.org', expect.any(Function));
  cleanup();
  vi.useRealTimers();
});

test('refreshes on a profile change only for a member of the open room', () => {
  vi.useFakeTimers();
  const { profileChanged, refresh, cleanup } = setup([{ user_id: '@alice:example.org' }]);
  profileChanged('@stranger:example.org');
  expect(refresh).not.toHaveBeenCalled();

  profileChanged('@alice:example.org');
  vi.runAllTimers();
  expect(refresh).toHaveBeenCalledOnce();
  cleanup();
  vi.useRealTimers();
});
