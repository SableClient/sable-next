import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const system = vi.hoisted(() => ({
  handler: null as ((action: { action: string; uuid: string; roomId?: string }) => void) | null,
  report: vi.fn((_call: { uuid: string }) => Promise.resolve(false)),
  end: vi.fn((_callId: string) => Promise.resolve(true)),
}));

vi.mock('#lib/platform/calls.js', () => ({
  reportIncomingSystemCall: system.report,
  endSystemCall: system.end,
  systemCallKey: (callId: string) => callId,
  listenSystemCallActions: (handler: typeof system.handler) => {
    system.handler = handler;
    return Promise.resolve(() => {});
  },
}));

import { IncomingCalls } from './incoming-calls.svelte.js';

function harness() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const declineCall = vi.fn(() => Promise.resolve());
  const client = {
    commands: { declineCall },
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
  sender_name: 'Bob',
  room_name: 'Room',
  ring: true,
  has_video: false,
  expires_at_ms: Date.now() + 30_000,
  ...overrides,
});

beforeEach(() => {
  preferences.ringForGroupCalls = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  system.report.mockClear();
  system.end.mockClear();
  system.handler = null;
});

test('an incoming call is surfaced', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();

  emit(incoming());

  expect(calls.calls).toHaveLength(1);
  expect(calls.calls[0].sender).toBe('@bob:example.org');
});

test('a group call is silent until the reader asks to be rung for them', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();

  emit(incoming({ ring: false }));
  expect(calls.calls).toHaveLength(0);

  preferences.ringForGroupCalls = true;
  emit(incoming({ ring: false }));
  expect(calls.calls).toHaveLength(1);
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

test('answering in the system call UI joins the room and keeps the system call', async () => {
  system.report.mockResolvedValueOnce(true);
  const { client, emit } = harness();
  const onAnswer = vi.fn();
  const calls = new IncomingCalls(client, onAnswer);
  calls.start();
  await Promise.resolve();

  emit(incoming({ has_video: true }));
  await vi.waitFor(() => {
    expect(system.report).toHaveBeenCalled();
  });
  const uuid = system.report.mock.calls[0]?.[0].uuid ?? '';
  await Promise.resolve();
  system.handler?.({ action: 'answer', uuid });

  expect(onAnswer).toHaveBeenCalledWith({
    uuid,
    callId: '$notify',
    roomId: '!room:example.org',
    hasVideo: true,
  });
  expect(calls.calls).toEqual([]);
  expect(system.end).not.toHaveBeenCalled();
});

test('a call answered from a push the app never saw still joins its room', async () => {
  const { client } = harness();
  const onAnswer = vi.fn();
  const calls = new IncomingCalls(client, onAnswer);
  calls.start();
  await Promise.resolve();

  system.handler?.({ action: 'answer', uuid: 'push-uuid', roomId: '!cold:example.org' });

  expect(onAnswer).toHaveBeenCalledWith({
    uuid: 'push-uuid',
    callId: 'push-uuid',
    roomId: '!cold:example.org',
    hasVideo: false,
  });
});

test('declining in the system call UI declines the Matrix call', async () => {
  system.report.mockResolvedValueOnce(true);
  const { client, emit, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  await Promise.resolve();

  emit(incoming());
  await vi.waitFor(() => {
    expect(system.report).toHaveBeenCalled();
  });
  await Promise.resolve();
  system.handler?.({ action: 'end', uuid: system.report.mock.calls.at(-1)?.[0].uuid ?? '' });

  expect(declineCall).toHaveBeenCalledWith('!room:example.org', '$notify');
  expect(calls.calls).toEqual([]);
});
