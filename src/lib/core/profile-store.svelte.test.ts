import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';

import { CoreError } from '../../transport';
import { ProfileStore } from './profile-store.svelte.js';

const profile = (display_name: string) => ({ display_name }) as ProfileView;

function setup() {
  const fetch = vi.fn<(userId: string) => Promise<ProfileView>>();
  const store = new ProfileStore({ accountId: () => 'account', fetch });
  return { store, fetch };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('get returns null, fetches in the background, then returns the profile', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValue(profile('a'));
  expect(store.get('@a:x')).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get('@a:x')).toEqual(profile('a'));
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('concurrent reads share one request', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValue(profile('a'));
  store.get('@a:x');
  store.get('@a:x');
  void store.load('@a:x');
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a stale profile is served while it is refetched', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValueOnce(profile('old')).mockResolvedValueOnce(profile('new'));
  store.get('@a:x');
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
  expect(store.get('@a:x')).toEqual(profile('old'));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get('@a:x')).toEqual(profile('new'));
});

test('invalidate keeps the old profile and refetches on the next read', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValueOnce(profile('old')).mockResolvedValueOnce(profile('new'));
  store.get('@a:x');
  await vi.advanceTimersByTimeAsync(0);
  store.invalidate('@a:x');
  expect(store.get('@a:x')).toEqual(profile('old'));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get('@a:x')).toEqual(profile('new'));
});

test('a lookup in flight when the profile changes does not refill the cache', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValueOnce(profile('stale')).mockResolvedValueOnce(profile('fresh'));
  const stale = store.load('@a:x');
  store.invalidate('@a:x');
  await stale;
  expect(store.get('@a:x')).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get('@a:x')).toEqual(profile('fresh'));
});

test('a failed lookup is not repeated inside the cool-down', async () => {
  const { store, fetch } = setup();
  const failure = new Error('boom');
  fetch.mockRejectedValue(failure);
  await expect(store.load('@a:x')).rejects.toBe(failure);
  await expect(store.load('@a:x')).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(store.load('@a:x')).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a rate-limited lookup is retried as soon as it is asked again', async () => {
  const { store, fetch } = setup();
  const limited = new CoreError({ code: 'rate_limited', retry_after_ms: 1000 });
  fetch.mockRejectedValueOnce(limited).mockResolvedValueOnce(profile('a'));
  await expect(store.load('@a:x')).rejects.toBe(limited);
  await expect(store.load('@a:x')).resolves.toEqual(profile('a'));
});

test('a burst of invalidations causes a single refetch', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValue(profile('a'));
  await store.load('@a:x');
  store.invalidate('@a:x');
  store.invalidate('@a:x');
  await vi.advanceTimersByTimeAsync(500);
  await store.load('@a:x');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('clear forgets everything', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValue(profile('a'));
  await store.load('@a:x');
  store.clear();
  expect(store.get('@a:x')).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
});
