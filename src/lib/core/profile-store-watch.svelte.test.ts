import { flushSync } from 'svelte';
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

test('a watching effect is woken to retry a rate-limited lookup', async () => {
  const { store, fetch } = setup();
  fetch
    .mockRejectedValueOnce(new CoreError({ code: 'rate_limited', retry_after_ms: null }))
    .mockResolvedValueOnce(profile('a'));
  const seen: (ProfileView | null)[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(store.get('@a:x'));
    });
  });
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.at(-1)).toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  flushSync();
  expect(seen.at(-1)).toEqual(profile('a'));
  stop();
});

test('a watching effect sees a changed profile without remounting', async () => {
  const { store, fetch } = setup();
  fetch.mockResolvedValueOnce(profile('old')).mockResolvedValueOnce(profile('new'));
  const seen: (ProfileView | null)[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(store.get('@a:x'));
    });
  });
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  store.invalidate('@a:x');
  await vi.advanceTimersByTimeAsync(500);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(seen.at(-1)).toEqual(profile('new'));
  stop();
});

test('a watching effect retries a failed lookup once its cool-down ends', async () => {
  const { store, fetch } = setup();
  fetch.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(profile('a'));
  const seen: (ProfileView | null)[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(store.get('@a:x'));
    });
  });
  flushSync();
  await vi.advanceTimersByTimeAsync(59_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(seen.at(-1)).toEqual(profile('a'));
  stop();
});

test('an unavailable profile is not retried', async () => {
  const { store, fetch } = setup();
  fetch.mockRejectedValue(new CoreError({ code: 'unavailable' }));
  const stop = $effect.root(() => {
    $effect(() => {
      store.get('@a:x');
    });
  });
  flushSync();
  await vi.advanceTimersByTimeAsync(120_000);
  flushSync();
  expect(fetch).toHaveBeenCalledTimes(1);
  stop();
});
