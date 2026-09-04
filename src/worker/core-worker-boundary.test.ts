import { expect, test, vi } from 'vitest';

import { createCoreWorkerBoundary, type WorkerCore, type WorkerPort } from './core-worker-boundary';
import type { WorkerMessage, WorkerRequest } from './protocol';

class FakePort implements WorkerPort {
  messages: WorkerMessage[] = [];
  onmessage: ((message: MessageEvent<WorkerRequest>) => unknown) | null = null;
  onmessageerror: ((event: MessageEvent) => unknown) | null = null;

  postMessage(message: WorkerMessage): void {
    this.messages.push(message);
  }

  start(): void {}

  send(request: WorkerRequest): Promise<void> {
    if (this.onmessage) this.onmessage({ data: request } as MessageEvent<WorkerRequest>);
    return new Promise((resolve) => setTimeout(resolve));
  }
}

function fakeCore(submitCommand: WorkerCore['submitCommand']): WorkerCore {
  return {
    submitCommand,
    fetchMedia: () => Promise.resolve(new Uint8Array(new ArrayBuffer())),
    sendAttachment: () => Promise.resolve(),
    uploadMedia: () => Promise.resolve(''),
  };
}

test('answers a health probe while a core command is pending', async () => {
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => new Promise<string>(() => {})))
  );
  const port = new FakePort();
  boundary.connect(port);

  void port.send({
    id: 1,
    command: { type: 'room_members', room_id: '!room', memberships: [] },
  });
  await port.send({ id: 2, ping: true });

  expect(port.messages).toEqual([{ id: 2, pong: true }]);
});

test('sends the subscription snapshot before startup events buffered for its port', async () => {
  let emit = (() => {}) as (json: string) => void;
  const core = fakeCore((command) => {
    const request = JSON.parse(command) as { type: string };
    if (request.type === 'subscribe_timeline') {
      emit(
        JSON.stringify([
          {
            type: 'timeline_pagination',
            subscription: 7,
            loading: true,
            reached_start: false,
          },
        ])
      );
      return Promise.resolve(
        JSON.stringify({ type: 'subscribe_timeline', subscription: 7, items: [] })
      );
    }
    return Promise.resolve(JSON.stringify({ type: request.type }));
  });
  const boundary = createCoreWorkerBoundary(Promise.resolve(core));
  emit = boundary.handleEvent;
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  await first.send({
    id: 1,
    command: {
      type: 'subscribe_timeline',
      room_id: '!room',
      focus: { kind: 'live' as const },
      hidden_events: false,
    },
  });

  expect(first.messages).toEqual([
    { id: 1, ok: { type: 'subscribe_timeline', subscription: 7, items: [] } },
    {
      event: { type: 'timeline_pagination', subscription: 7, loading: true, reached_start: false },
    },
  ]);
  expect(second.messages).toEqual([]);
});

test('denies cross-port pagination and unsubscribe without calling the core', async () => {
  const commands: string[] = [];
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(
      fakeCore((command) => {
        commands.push(command);
        return Promise.resolve(
          JSON.stringify({ type: 'subscribe_timeline', subscription: 7, items: [] })
        );
      })
    )
  );
  const owner = new FakePort();
  const other = new FakePort();
  boundary.connect(owner);
  boundary.connect(other);
  await owner.send({
    id: 1,
    command: {
      type: 'subscribe_timeline',
      room_id: '!room',
      focus: { kind: 'live' as const },
      hidden_events: false,
    },
  });

  await other.send({
    id: 2,
    command: { type: 'paginate', subscription: 7, direction: 'backward', count: 20 },
  });
  await other.send({ id: 3, command: { type: 'unsubscribe', subscription: 7 } });

  expect(commands).toHaveLength(1);
  expect(other.messages).toEqual([
    { id: 2, err: { code: 'denied' } },
    { id: 3, err: { code: 'denied' } },
  ]);
});

test('cleans up active and pending subscriptions when their ports close', async () => {
  let resolveSubscribe: ((value: string) => void) | undefined;
  const commands: string[] = [];
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(
      fakeCore((command) => {
        commands.push(command);
        if (commands.length === 1)
          return Promise.resolve(
            JSON.stringify({ type: 'subscribe_timeline', subscription: 7, items: [] })
          );
        if (commands.length === 2) return new Promise((resolve) => (resolveSubscribe = resolve));
        return Promise.resolve(JSON.stringify({ type: 'unsubscribe' }));
      })
    )
  );
  const active = new FakePort();
  const pending = new FakePort();
  boundary.connect(active);
  boundary.connect(pending);
  await active.send({
    id: 1,
    command: {
      type: 'subscribe_timeline',
      room_id: '!active',
      focus: { kind: 'live' as const },
      hidden_events: false,
    },
  });
  await pending.send({
    id: 2,
    command: {
      type: 'subscribe_timeline',
      room_id: '!pending',
      focus: { kind: 'live' as const },
      hidden_events: false,
    },
  });

  active.onmessageerror?.({} as MessageEvent);
  pending.onmessageerror?.({} as MessageEvent);
  resolveSubscribe?.(JSON.stringify({ type: 'subscribe_timeline', subscription: 8, items: [] }));
  await new Promise((resolve) => setTimeout(resolve));

  expect(
    commands.map((command) => JSON.parse(command) as { type: string; subscription?: number })
  ).toEqual([
    {
      type: 'subscribe_timeline',
      room_id: '!active',
      focus: { kind: 'live' as const },
      hidden_events: false,
    },
    {
      type: 'subscribe_timeline',
      room_id: '!pending',
      focus: { kind: 'live' as const },
      hidden_events: false,
    },
    { type: 'unsubscribe', subscription: 7 },
    { type: 'unsubscribe', subscription: 8 },
  ]);
  expect(active.messages).toHaveLength(1);
  expect(pending.messages).toEqual([]);
});

test('a panic reaches every port and later commands fail instead of hanging', async () => {
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(() => new Promise(() => {}))));
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  boundary.handlePanic('index out of bounds');
  await first.send({ id: 1, command: { type: 'restore' } });

  expect(second.messages).toEqual([{ panic: { message: 'index out of bounds' } }]);
  expect(first.messages).toEqual([
    { panic: { message: 'index out of bounds' } },
    { id: 1, err: { code: 'failed', log_id: 'core panicked: index out of bounds' } },
  ]);
});

test('WASM logs are batched to every connected port', () => {
  const setLogCapture = vi.fn();
  vi.useFakeTimers();
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve('{}'))),
    setLogCapture
  );
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  boundary.handleLog('INFO sable_core: sync started\n');
  boundary.handleLog('INFO sable_core: sync caught up\n');
  const firstBatch = first.messages;
  expect(second.messages).toEqual([]);
  vi.advanceTimersByTime(250);

  expect(firstBatch).toEqual([
    { logs: ['INFO sable_core: sync started', 'INFO sable_core: sync caught up'] },
  ]);
  expect(second.messages).toEqual(firstBatch);
  vi.useRealTimers();
});

test('overflowing the log buffer drops and reports the excess', () => {
  const setLogCapture = vi.fn();
  vi.useFakeTimers();
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve('{}'))),
    setLogCapture
  );
  const port = new FakePort();
  boundary.connect(port);

  for (let index = 0; index < 502; index += 1) boundary.handleLog(`line ${index}`);
  vi.advanceTimersByTime(250);

  expect(port.messages).toHaveLength(1);
  const batch = (port.messages[0] as { logs: string[] }).logs;
  expect(batch).toHaveLength(501);
  expect(batch[500]).toBe('+2 core log lines dropped');
  vi.useRealTimers();
});

test('a reset request terminates the worker after answering', () => {
  const terminate = vi.fn();
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve('{}'))),
    undefined,
    terminate
  );
  const port = new FakePort();
  boundary.connect(port);

  port.onmessage?.({ data: { id: 1, reset: true } } as MessageEvent<WorkerRequest>);

  expect(terminate).toHaveBeenCalledTimes(1);
  expect(port.messages).toEqual([{ id: 1, uri: null }]);
});

test('a reset request fails while another port is connected', () => {
  const terminate = vi.fn();
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve('{}'))),
    undefined,
    terminate
  );
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  first.onmessage?.({ data: { id: 1, reset: true } } as MessageEvent<WorkerRequest>);

  expect(terminate).not.toHaveBeenCalled();
  expect(first.messages).toEqual([
    { id: 1, err: { code: 'failed', log_id: 'close other Sable tabs before resetting the cache' } },
  ]);
  expect(second.messages).toEqual([]);
});

test('a debugLogs request toggles WASM capture and clears buffered logs', () => {
  const setLogCapture = vi.fn();
  vi.useFakeTimers();
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve('{}'))),
    setLogCapture
  );
  const port = new FakePort();
  boundary.connect(port);

  boundary.handleLog('INFO sable_core: sync started');
  port.onmessage?.({ data: { debugLogs: false } } as MessageEvent<WorkerRequest>);
  vi.advanceTimersByTime(250);

  expect(setLogCapture).toHaveBeenCalledWith(false);
  expect(port.messages).toEqual([]);
  vi.useRealTimers();
});
