import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/CoreEvent';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { IncomingCalls } from './incoming-calls.svelte.js';

function harness() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const declineCall = vi.fn(() => Promise.resolve());
  const client = {
    declineCall,
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CoreClient;

  return {
    client,
    declineCall,
    emit: (event: CoreEvent) => {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
  };
}

const incoming = (overrides: Partial<Record<string, unknown>> = {}): CoreEvent => ({
  type: 'incoming_call',
  room_id: '!room:example.org',
  notification_event_id: '$notify',
  sender: '@bob:example.org',
  ring: true,
  expires_at_ms: Date.now() + 30_000,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

test('an incoming call is surfaced', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();

  emit(incoming());

  expect(calls.calls).toHaveLength(1);
  expect(calls.calls[0].sender).toBe('@bob:example.org');
});

test('an already-expired notification never appears', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();

  emit(incoming({ expires_at_ms: Date.now() - 1 }));

  expect(calls.calls).toHaveLength(0);
});

test('a prompt lapses on its own when the caller goes away', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming({ expires_at_ms: Date.now() + 5_000 }));

  vi.advanceTimersByTime(5_001);

  expect(calls.calls).toHaveLength(0);
});

test('a withdrawal clears the matching prompt only', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming({ notification_event_id: '$one' }));
  emit(incoming({ notification_event_id: '$two' }));

  emit({ type: 'incoming_call_ended', notification_event_id: '$one' });

  expect(calls.calls.map((call) => call.notificationEventId)).toEqual(['$two']);
});

test('a repeated notification does not stack a second prompt', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();

  emit(incoming());
  emit(incoming());

  expect(calls.calls).toHaveLength(1);
});

test('declining tells the core and dismisses the prompt', async () => {
  const { client, emit, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming());

  await calls.decline(calls.calls[0]);

  expect(declineCall).toHaveBeenCalledWith('!room:example.org', '$notify');
  expect(calls.calls).toHaveLength(0);
});

test('accepting dismisses the prompt without declining', () => {
  const { client, emit, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming());

  calls.accept(calls.calls[0]);

  expect(declineCall).not.toHaveBeenCalled();
  expect(calls.calls).toHaveLength(0);
});
