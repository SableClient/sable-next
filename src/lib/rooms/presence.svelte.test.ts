import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/CoreEvent';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { lastSeenBucket, lastSeenMs, PresenceStore } from './presence.svelte.js';

function harness() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const client = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CoreClient;

  return {
    client,
    emit: (event: CoreEvent) => {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
    listenerCount: () => listeners.size,
  };
}

const presenceEvent = (overrides: Partial<Record<string, unknown>> = {}): CoreEvent => ({
  type: 'presence',
  user_id: '@bob:example.org',
  presence: 'online',
  status_message: null,
  last_active_ago: null,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

test('a presence event becomes readable by user id', () => {
  const { client, emit } = harness();
  const store = new PresenceStore();
  store.start(client);

  emit(presenceEvent({ presence: 'unavailable', status_message: 'In a meeting' }));

  const entry = store.get('@bob:example.org');
  expect(entry?.presence).toBe('unavailable');
  expect(entry?.statusMessage).toBe('In a meeting');
});

test('an unknown user has no presence entry', () => {
  const store = new PresenceStore();
  expect(store.get('@nobody:example.org')).toBeNull();
});

test('other core events are ignored', () => {
  const { client, emit } = harness();
  const store = new PresenceStore();
  store.start(client);

  emit({ type: 'session_ended', reason: 'test' });

  expect(store.get('@bob:example.org')).toBeNull();
});

test('stop detaches the subscription', () => {
  const { client, emit, listenerCount } = harness();
  const store = new PresenceStore();
  store.start(client);
  expect(listenerCount()).toBe(1);

  store.stop();
  expect(listenerCount()).toBe(0);

  emit(presenceEvent());
  expect(store.get('@bob:example.org')).toBeNull();
});

test('lastSeenMs adds elapsed time since the event was received', () => {
  const receivedAt = Date.now();
  vi.advanceTimersByTime(5_000);

  expect(lastSeenMs({ lastActiveAgo: 10_000, receivedAt }, Date.now())).toBe(15_000);
});

test('lastSeenMs is null when the core never reported an age', () => {
  expect(lastSeenMs({ lastActiveAgo: null, receivedAt: Date.now() }, Date.now())).toBeNull();
});

test('lastSeenBucket buckets by minutes, hours and days', () => {
  expect(lastSeenBucket(30_000)).toEqual({ kind: 'now' });
  expect(lastSeenBucket(5 * 60_000)).toEqual({ kind: 'minutes', count: 5 });
  expect(lastSeenBucket(3 * 60 * 60_000)).toEqual({ kind: 'hours', count: 3 });
  expect(lastSeenBucket(2 * 24 * 60 * 60_000)).toEqual({ kind: 'days', count: 2 });
});
