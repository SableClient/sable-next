import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SystemCallAction } from '#lib/platform/calls.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const system = vi.hoisted(() => ({
  platform: 'android',
  handler: null as ((action: SystemCallAction) => void) | null,
  report: vi.fn((_call: { uuid: string }) => Promise.resolve(false)),
  end: vi.fn((_callId: string) => Promise.resolve(true)),
  play: vi.fn<() => Promise<{ stop: () => void }>>(() => Promise.resolve({ stop: vi.fn() })),
}));

vi.mock('#lib/platform/os.js', () => ({
  isAndroid: () => system.platform === 'android',
  isNativeMobile: () => false,
}));

vi.mock('#lib/platform/calls.js', () => ({
  reportIncomingSystemCall: system.report,
  endSystemCall: system.end,
  systemCallKey: (callId: string, uuid: string) => (system.platform === 'ios' ? uuid : callId),
  listenSystemCallActions: (handler: typeof system.handler) => {
    system.handler = handler;
    return Promise.resolve(() => {});
  },
}));

vi.mock('#lib/features/notifications/sound.js', () => ({
  playSound: system.play,
}));

import { IncomingCalls } from './incoming-calls.svelte.js';

function harness() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const declineCall = vi.fn(() => Promise.resolve());
  const client = {
    rpc: { calls: { decline: declineCall } },
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
  system.platform = 'android';
  preferences.ringForGroupCalls = false;
  preferences.incomingCallSound = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  system.report.mockClear();
  system.end.mockClear();
  system.handler = null;
  system.play.mockClear();
});

test('Android leaves ringing to native notifications', async () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming());
  expect(system.play).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(system.play).not.toHaveBeenCalled();
  calls.stop();
});

test('the fallback ringtone waits for native reporting to fail', async () => {
  system.platform = 'ios';
  let complete!: (taken: boolean) => void;
  system.report.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming());
  expect(system.play).not.toHaveBeenCalled();
  complete(false);
  await Promise.resolve();
  expect(system.play).toHaveBeenCalledExactlyOnceWith('incoming_call', { loop: true });
  calls.stop();
});

test('a ringtone that finishes loading after dismissal is stopped', async () => {
  system.platform = 'web';
  let complete!: (sound: { stop: () => void }) => void;
  system.play.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming());
  await Promise.resolve();
  calls.accept(calls.calls[0]);
  const stop = vi.fn();
  complete({ stop });
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
  calls.stop();
});

test('an incoming call is surfaced', () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();

  emit(incoming());

  expect(calls.calls).toHaveLength(1);
  expect(calls.calls[0].sender).toBe('@bob:example.org');
});

test('group invitations stay visible when group ringing is disabled', () => {
  system.platform = 'web';
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();

  emit(incoming({ ring: false }));
  expect(calls.calls).toHaveLength(1);
  expect(system.report).not.toHaveBeenCalled();
  expect(system.play).not.toHaveBeenCalled();

  preferences.ringForGroupCalls = true;
  emit(incoming({ ring: false }));
  expect(calls.calls).toHaveLength(1);
  expect(system.report).toHaveBeenCalledOnce();
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

  expect(declineCall).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    notification_event_id: '$notify',
  });
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
  await Promise.resolve();
  system.handler?.({ action: 'answer', uuid: '$notify' });

  expect(onAnswer).toHaveBeenCalledWith({
    uuid: '$notify',
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
  system.handler?.({ action: 'end', uuid: '$notify' });

  expect(declineCall).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    notification_event_id: '$notify',
  });
  expect(calls.calls).toEqual([]);
});

test('an iOS answer keeps its UUID as the system call key', async () => {
  system.platform = 'ios';
  system.report.mockResolvedValueOnce(true);
  const { client, emit } = harness();
  const onAnswer = vi.fn();
  const calls = new IncomingCalls(client, onAnswer);
  calls.start();
  emit(incoming());
  await Promise.resolve();
  const uuid = system.report.mock.calls[0][0].uuid;

  system.handler?.({ action: 'answer', uuid });

  expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ uuid, callId: uuid }));
  expect(system.end).not.toHaveBeenCalled();
});

test('an answer before reporting completes keeps the system call alive', async () => {
  let complete!: (taken: boolean) => void;
  system.report.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
  );
  const { client, emit } = harness();
  const onAnswer = vi.fn();
  const calls = new IncomingCalls(client, onAnswer);
  calls.start();
  emit(incoming());

  system.handler?.({ action: 'answer', uuid: '$notify' });
  complete(true);
  await Promise.resolve();

  expect(onAnswer).toHaveBeenCalledOnce();
  expect(system.end).not.toHaveBeenCalled();
});

test('a cold native decline sends the invitation ID to the core once', async () => {
  const { client, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  await Promise.resolve();
  const action: SystemCallAction = {
    action: 'end',
    uuid: 'cold-uuid',
    roomId: '!cold:example.org',
    notificationEventId: '$cold',
  };

  system.handler?.(action);
  system.handler?.(action);

  expect(declineCall).toHaveBeenCalledExactlyOnceWith({
    room_id: '!cold:example.org',
    notification_event_id: '$cold',
  });
  expect(system.end).not.toHaveBeenCalled();
  calls.stop();
});

test('a cold native video answer preserves metadata and ignores its later end', async () => {
  system.platform = 'ios';
  const { client, declineCall } = harness();
  const onAnswer = vi.fn();
  const calls = new IncomingCalls(client, onAnswer);
  calls.start();
  await Promise.resolve();
  const action: SystemCallAction = {
    action: 'answer',
    uuid: 'cold-uuid',
    roomId: '!cold:example.org',
    notificationEventId: '$cold',
    hasVideo: true,
  };

  system.handler?.(action);
  system.handler?.(action);
  system.handler?.({ ...action, action: 'end' });

  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
    uuid: 'cold-uuid',
    callId: 'cold-uuid',
    roomId: '!cold:example.org',
    hasVideo: true,
  });
  expect(declineCall).not.toHaveBeenCalled();
  calls.stop();
});

test('a late core event cannot reopen an answered cold invitation', async () => {
  const { client, emit } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  await Promise.resolve();

  system.handler?.({
    action: 'answer',
    uuid: 'cold-uuid',
    roomId: '!room:example.org',
    notificationEventId: '$notify',
  });
  emit(incoming());

  expect(calls.calls).toEqual([]);
  expect(system.report).not.toHaveBeenCalled();
  calls.stop();
});

test('the invitation ID matches a cold native action to an existing prompt', async () => {
  system.platform = 'ios';
  const { client, emit, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming());
  await Promise.resolve();

  system.handler?.({
    action: 'end',
    uuid: 'push-uuid',
    roomId: '!room:example.org',
    notificationEventId: '$notify',
  });

  expect(declineCall).toHaveBeenCalledExactlyOnceWith({
    room_id: '!room:example.org',
    notification_event_id: '$notify',
  });
  expect(calls.calls).toEqual([]);
  calls.stop();
});

test('an end after accepting in the app does not decline the invitation', async () => {
  const { client, emit, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  emit(incoming());
  await Promise.resolve();
  calls.accept(calls.calls[0]);

  system.handler?.({
    action: 'end',
    uuid: 'push-uuid',
    roomId: '!room:example.org',
    notificationEventId: '$notify',
  });

  expect(declineCall).not.toHaveBeenCalled();
  calls.stop();
});

test('cold native declines require both room and invitation IDs', async () => {
  const { client, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  await Promise.resolve();

  system.handler?.({ action: 'end', uuid: 'unknown', roomId: '!room:example.org' });
  system.handler?.({ action: 'end', uuid: 'unknown', notificationEventId: '$notify' });

  expect(declineCall).not.toHaveBeenCalled();
  calls.stop();
});

test('stopped listeners cannot decline a cold invitation', async () => {
  const { client, declineCall } = harness();
  const calls = new IncomingCalls(client);
  calls.start();
  await Promise.resolve();
  calls.stop();

  system.handler?.({
    action: 'end',
    uuid: 'push-uuid',
    roomId: '!room:example.org',
    notificationEventId: '$notify',
  });

  expect(declineCall).not.toHaveBeenCalled();
});

test('a push answer keeps the native UUID when the app also has a prompt', async () => {
  system.platform = 'ios';
  const { client, emit, declineCall } = harness();
  const onAnswer = vi.fn();
  const calls = new IncomingCalls(client, onAnswer);
  calls.start();
  emit(incoming());
  await Promise.resolve();

  system.handler?.({
    action: 'answer',
    uuid: 'push-uuid',
    roomId: '!room:example.org',
    notificationEventId: '$notify',
  });

  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
    uuid: 'push-uuid',
    callId: 'push-uuid',
    roomId: '!room:example.org',
    hasVideo: false,
  });
  expect(declineCall).not.toHaveBeenCalled();
  expect(calls.calls).toEqual([]);
  calls.stop();
});

test('a cold Android answer uses the invitation ID as its system call key', async () => {
  const { client } = harness();
  const onAnswer = vi.fn();
  const calls = new IncomingCalls(client, onAnswer);
  calls.start();
  await Promise.resolve();

  system.handler?.({
    action: 'answer',
    uuid: 'push-uuid',
    roomId: '!room:example.org',
    notificationEventId: '$notify',
  });

  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
    uuid: 'push-uuid',
    callId: '$notify',
    roomId: '!room:example.org',
    hasVideo: false,
  });
  calls.stop();
});
