import { expect, test } from 'vitest';

import type { MemberView } from '#src/generated/MemberView';

import { RoomMemberLoader } from './room-members.svelte';

function member(userId: string): MemberView {
  return {
    user_id: userId,
    display_name: null,
    avatar_url: null,
    power_level: 0,
    membership: 'join',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('a failed load settles without rejecting and is not retried', async () => {
  const loader = new RoomMemberLoader();
  let calls = 0;
  const fetchMembers = () => {
    calls += 1;
    return Promise.reject(new Error('failed'));
  };

  await expect(loader.load('!room:example.org', fetchMembers)).resolves.toBeUndefined();
  await loader.load('!room:example.org', fetchMembers);
  await loader.load('!room:example.org', fetchMembers);

  expect(calls).toBe(1);
  expect(loader.loading).toBe(false);
  expect(loader.members).toEqual([]);
});

test('resetting clears the failure so the room can be loaded again', async () => {
  const loader = new RoomMemberLoader();
  let calls = 0;
  const fetchMembers = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('failed')) : Promise.resolve([member('@a:b')]);
  };

  await loader.load('!room:example.org', fetchMembers);
  loader.reset();
  await loader.load('!room:example.org', fetchMembers);

  expect(calls).toBe(2);
  expect(loader.members.map((entry) => entry.user_id)).toEqual(['@a:b']);
});

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
