// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';
import type { CoreEvent, MemberView } from '#src/generated/protocol';
import { refreshRoomMembers } from './room-member-refresh.svelte.js';

const ROOM = '!room:example.org';

function member(userId: string): MemberView {
  return {
    user_id: userId,
    display_name: null,
    avatar_url: null,
    real_name: null,
    real_avatar_url: null,
    power_level: 0,
    membership: 'join',
    member_ts: 1,
    kicked: false,
    service: false,
  };
}

function setup(members: Pick<MemberView, 'user_id'>[] = []) {
  let emit!: (event: CoreEvent) => void;
  const refresh = vi.fn(() => Promise.resolve());
  const upsert = vi.fn();
  const core = {
    rpc: { members: { list: vi.fn() } },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      emit = listener;
      return () => {};
    },
  };
  const cleanup = $effect.root(() => {
    refreshRoomMembers(core as never, { refresh, upsert, members } as never, () => ROOM);
  });
  flushSync();
  return { emit, refresh, upsert, cleanup };
}

test('applies the member carried by a membership change without reloading the list', () => {
  vi.useFakeTimers();
  const { emit, refresh, upsert, cleanup } = setup();
  const alice = member('@alice:example.org');
  emit({ type: 'members_changed', room_id: '!other:example.org', member: alice });
  emit({ type: 'members_changed', room_id: ROOM, member: alice });

  vi.runAllTimers();
  expect(upsert).toHaveBeenCalledExactlyOnceWith(ROOM, alice);
  expect(refresh).not.toHaveBeenCalled();
  cleanup();
  vi.useRealTimers();
});

test('reloads the members once per burst when a change carries no member', () => {
  vi.useFakeTimers();
  const { emit, refresh, cleanup } = setup();
  for (let i = 0; i < 5; i += 1) emit({ type: 'members_changed', room_id: ROOM, member: null });
  expect(refresh).not.toHaveBeenCalled();

  vi.runAllTimers();
  expect(refresh).toHaveBeenCalledExactlyOnceWith(ROOM, expect.any(Function));
  cleanup();
  vi.useRealTimers();
});

test('reloads on a nickname change only for a member of the open room', () => {
  vi.useFakeTimers();
  const { emit, refresh, cleanup } = setup([{ user_id: '@alice:example.org' }]);
  emit({ type: 'nicknames_changed', user_ids: ['@stranger:example.org'] });
  vi.runAllTimers();
  expect(refresh).not.toHaveBeenCalled();

  emit({ type: 'nicknames_changed', user_ids: ['@alice:example.org'] });
  vi.runAllTimers();
  expect(refresh).toHaveBeenCalledOnce();
  cleanup();
  vi.useRealTimers();
});
