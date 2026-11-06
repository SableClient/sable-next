import { afterEach, expect, test, vi } from 'vitest';

import type { MemberView } from '#src/generated/protocol';

import { MEMBER_RETRY_DELAYS_MS, RoomMemberLoader } from './room-members.svelte';

afterEach(() => vi.useRealTimers());

function member(userId: string, displayName: string | null = null): MemberView {
  return {
    user_id: userId,
    display_name: displayName,
    real_name: displayName,
    real_avatar_url: null,
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

test('retries failed and empty loads', async () => {
  vi.useFakeTimers();
  const loader = new RoomMemberLoader();
  const fetchMembers = vi
    .fn<() => Promise<MemberView[]>>()
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValueOnce([])
    .mockResolvedValue([member('@a:b')]);
  const load = loader.load('!room:example.org', fetchMembers);
  await vi.runAllTimersAsync();
  await expect(load).resolves.toBeUndefined();
  expect(fetchMembers).toHaveBeenCalledTimes(3);
  expect(loader.loading).toBe(false);
  expect(loader.members.map((entry) => entry.user_id)).toEqual(['@a:b']);
});

test('stops after the last retry', async () => {
  vi.useFakeTimers();
  const loader = new RoomMemberLoader();
  const fetchMembers = vi.fn(() => Promise.reject(new Error('failed')));
  const load = loader.load('!room:example.org', fetchMembers);
  await vi.runAllTimersAsync();
  await load;
  await loader.load('!room:example.org', fetchMembers);
  expect(fetchMembers).toHaveBeenCalledTimes(MEMBER_RETRY_DELAYS_MS.length + 1);
  expect(loader.loading).toBe(false);
  expect(loader.members).toEqual([]);
});

test('reset cancels retries and allows reloading', async () => {
  vi.useFakeTimers();
  const loader = new RoomMemberLoader();
  const fetchMembers = vi
    .fn<() => Promise<MemberView[]>>()
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValue([member('@a:b')]);
  const first = loader.load('!room:example.org', fetchMembers);
  await vi.advanceTimersByTimeAsync(0);
  loader.reset();
  await vi.runAllTimersAsync();
  await first;
  expect(fetchMembers).toHaveBeenCalledTimes(1);
  await loader.load('!room:example.org', fetchMembers);
  expect(fetchMembers).toHaveBeenCalledTimes(2);
  expect(loader.members.map((entry) => entry.user_id)).toEqual(['@a:b']);
});

test('a pending member load cannot block or replace the next room', async () => {
  const loader = new RoomMemberLoader();
  const first = deferred<MemberView[]>();
  const second = deferred<MemberView[]>();
  const fetchMembers = (roomId: string) =>
    roomId === '!first:example.org' ? first.promise : second.promise;

  const firstLoad = loader.load('!first:example.org', fetchMembers);
  expect(loader.roomId).toBe('!first:example.org');
  loader.reset();
  expect(loader.roomId).toBeNull();
  const secondLoad = loader.load('!second:example.org', fetchMembers);

  first.resolve([member('@first:example.org')]);
  await firstLoad;
  expect(loader.roomId).toBe('!second:example.org');
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

test('refreshes that overlap collapse into one follow-up read', async () => {
  const loader = new RoomMemberLoader();
  await loader.load('!room:example.org', () => Promise.resolve([member('@a:b')]));
  const reads = [deferred<MemberView[]>(), deferred<MemberView[]>()];
  const fetchMembers = vi.fn(() => reads[fetchMembers.mock.calls.length - 1].promise);

  const first = loader.refresh('!room:example.org', fetchMembers);
  void loader.refresh('!room:example.org', fetchMembers);
  void loader.refresh('!room:example.org', fetchMembers);
  expect(fetchMembers).toHaveBeenCalledTimes(1);

  reads[0].resolve([member('@a:b')]);
  await vi.waitFor(() => {
    expect(fetchMembers).toHaveBeenCalledTimes(2);
  });
  reads[1].resolve([member('@a:b'), member('@c:d')]);
  await first;

  expect(loader.members.map((entry) => entry.user_id)).toEqual(['@a:b', '@c:d']);
});

test('a power level change patches the loaded members', async () => {
  const loader = new RoomMemberLoader();
  await loader.load('!room:example.org', () => Promise.resolve([member('@a:b'), member('@c:d')]));
  loader.setPowerLevel('!other:example.org', '@a:b', 50);
  expect(loader.members.map((entry) => entry.power_level)).toEqual([0, 0]);

  loader.setPowerLevel('!room:example.org', '@a:b', 50);
  expect(loader.members.map((entry) => entry.power_level)).toEqual([50, 0]);
});

test('an upsert replaces a known member and appends a new one', async () => {
  const loader = new RoomMemberLoader();
  await loader.load('!room:example.org', () => Promise.resolve([member('@a:b'), member('@c:d')]));
  loader.upsert('!other:example.org', member('@a:b', 'Elsewhere'));
  expect(loader.members.map((entry) => entry.display_name)).toEqual([null, null]);

  loader.upsert('!room:example.org', member('@a:b', 'Renamed'));
  loader.upsert('!room:example.org', member('@e:f', 'Joined'));
  expect(loader.members.map((entry) => [entry.user_id, entry.display_name])).toEqual([
    ['@a:b', 'Renamed'],
    ['@c:d', null],
    ['@e:f', 'Joined'],
  ]);
});
