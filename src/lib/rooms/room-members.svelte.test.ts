import { expect, test } from 'vitest';

import type { MemberView } from '@/generated/MemberView';

import { RoomMemberLoader } from './room-members.svelte';

function member(userId: string): MemberView {
  return {
    user_id: userId,
    display_name: null,
    avatar_url: null,
    power_level: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('a pending member load cannot block or replace the next room', async () => {
  const loader = new RoomMemberLoader();
  const first = deferred<MemberView[]>();
  const second = deferred<MemberView[]>();
  const fetchMembers = (roomId: string) =>
    roomId === '!first:example.org' ? first.promise : second.promise;

  const firstLoad = loader.load('!first:example.org', fetchMembers);
  loader.reset();
  const secondLoad = loader.load('!second:example.org', fetchMembers);

  first.resolve([member('@first:example.org')]);
  await firstLoad;
  expect(loader.members).toEqual([]);
  expect(loader.loading).toBe(true);

  second.resolve([member('@second:example.org')]);
  await secondLoad;
  expect(loader.members.map((entry) => entry.user_id)).toEqual(['@second:example.org']);
  expect(loader.loading).toBe(false);
});
