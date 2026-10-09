import { expect, test, vi } from 'vitest';

import type { MemberView } from '#src/generated/protocol';

import { MEMBER_RETRY_DELAYS_MS, RoomMemberLoader } from './room-members.svelte';

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

test('a failed or empty load retries on a backoff, then settles', async () => {
  vi.useFakeTimers();
  try {
    const loader = new RoomMemberLoader();
    let calls = 0;
    const fetchMembers = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('failed'));
      return Promise.resolve(calls === 2 ? [] : [member('@a:b')]);
    };

    const load = loader.load('!room:example.org', fetchMembers);
    await vi.runAllTimersAsync();
    await expect(load).resolves.toBeUndefined();

    expect(calls).toBe(3);
    expect(loader.loading).toBe(false);
    expect(loader.members.map((entry) => entry.user_id)).toEqual(['@a:b']);
  } finally {
    vi.useRealTimers();
  }
});

test('a load that keeps failing gives up after the last retry', async () => {
  vi.useFakeTimers();
  try {
    const loader = new RoomMemberLoader();
    let calls = 0;
    const fetchMembers = () => {
      calls += 1;
      return Promise.reject(new Error('failed'));
    };

    const load = loader.load('!room:example.org', fetchMembers);
    await vi.runAllTimersAsync();
    await load;
    await loader.load('!room:example.org', fetchMembers);

    expect(calls).toBe(MEMBER_RETRY_DELAYS_MS.length + 1);
    expect(loader.loading).toBe(false);
    expect(loader.members).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test('resetting stops the retries and lets the room load again', async () => {
  vi.useFakeTimers();
  try {
    const loader = new RoomMemberLoader();
    let calls = 0;
    const fetchMembers = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('failed')) : Promise.resolve([member('@a:b')]);
    };

    const first = loader.load('!room:example.org', fetchMembers);
    await vi.advanceTimersByTimeAsync(0);
    loader.reset();
    await vi.runAllTimersAsync();
    await first;
    expect(calls).toBe(1);

    await loader.load('!room:example.org', fetchMembers);
    expect(calls).toBe(2);
    expect(loader.members.map((entry) => entry.user_id)).toEqual(['@a:b']);
  } finally {
    vi.useRealTimers();
  }
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
