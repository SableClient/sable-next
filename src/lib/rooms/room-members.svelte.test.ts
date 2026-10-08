import { expect, test } from 'vitest';

import type { MemberView } from '#src/generated/protocol';

import { RoomMemberLoader } from './room-members.svelte';

function member(userId: string, displayName: string | null = null): MemberView {
  return {
    user_id: userId,
    display_name: displayName,
    avatar_url: null,
    power_level: 0,
    membership: 'join',
    member_ts: null,
    kicked: false,
    service: false,
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

test('a revisited room waits for its current members', async () => {
  const loader = new RoomMemberLoader();
  const refetch = deferred<MemberView[]>();
  let calls = 0;
  const fetchMembers = () => {
    calls += 1;
    return calls === 1 ? Promise.resolve([member('@a:b', 'Alice')]) : refetch.promise;
  };

  await loader.load('!room:example.org', fetchMembers);
  loader.reset();
  expect(loader.members).toEqual([]);

  const revisit = loader.load('!room:example.org', fetchMembers);
  expect(loader.members).toEqual([]);
  expect(loader.loading).toBe(true);

  refetch.resolve([member('@a:b', 'Alice Renamed')]);
  await revisit;

  expect(loader.members.map((entry) => entry.display_name)).toEqual(['Alice Renamed']);
  expect(loader.loading).toBe(false);
  expect(calls).toBe(2);
});

test('a power level change patches the loaded members', async () => {
  const loader = new RoomMemberLoader();
  await loader.load('!room:example.org', () => Promise.resolve([member('@a:b'), member('@c:d')]));
  loader.setPowerLevel('!other:example.org', '@a:b', 50);
  expect(loader.members.map((entry) => entry.power_level)).toEqual([0, 0]);

  loader.setPowerLevel('!room:example.org', '@a:b', 50);
  expect(loader.members.map((entry) => entry.power_level)).toEqual([50, 0]);
});
