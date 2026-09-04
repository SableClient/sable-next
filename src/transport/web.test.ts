import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../worker/core.worker.ts?sharedworker&url', () => ({ default: 'core.worker.js' }));
vi.mock('#src/generated/wasm/sable_wasm_version.js', () => ({ default: 'test-wasm-version' }));

class FakePort {
  onmessage: ((message: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  respondToPings = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
    if (
      this.respondToPings &&
      message &&
      typeof message === 'object' &&
      'ping' in message &&
      'id' in message &&
      typeof message.id === 'number'
    ) {
      const { id } = message;
      queueMicrotask(() => {
        this.receive({ id, pong: true });
      });
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'reset' in message &&
      'id' in message &&
      typeof message.id === 'number'
    ) {
      const { id } = message;
      queueMicrotask(() => {
        this.receive({ id, uri: null });
      });
    }
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  start(): void {}

  close(): void {}
}

class FakeSharedWorker {
  static last: FakeSharedWorker | null = null;
  port = new FakePort();
  url: URL;

  constructor(url: string | URL) {
    this.url = new URL(url);
    FakeSharedWorker.last = this;
  }

  addEventListener(): void {}
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSharedWorker.last = null;
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  vi.stubGlobal('self', { location: new URL('https://sable.test/room') });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function stalledFor(
  send: (transport: Awaited<ReturnType<typeof load>>) => void,
  respondToPings = false
) {
  const transport = await load();
  let stalled = false;
  transport.subscribeStall((next: boolean) => {
    stalled = next;
  });
  send(transport);
  if (FakeSharedWorker.last) FakeSharedWorker.last.port.respondToPings = respondToPings;
  await vi.advanceTimersByTimeAsync(60_000);
  return stalled;
}

async function load() {
  const { createWebTransport } = await import('./web');
  return createWebTransport();
}

test('uses a WASM-specific worker URL', async () => {
  const transport = await load();
  void transport.send({ type: 'room_members', room_id: '!r:example.org' } as never);

  expect(FakeSharedWorker.last?.url.searchParams.get('wasm')).toBeTruthy();
}, 20_000);

test('a slow command reports an unresponsive worker', async () => {
  expect(
    await stalledFor((transport) => {
      void transport.send({ type: 'room_members', room_id: '!r:example.org' } as never);
    })
  ).toBe(true);
});

test('a slow command does not report a responsive worker as unresponsive', async () => {
  expect(
    await stalledFor((transport) => {
      void transport.send({ type: 'room_members', room_id: '!r:example.org' } as never);
    }, true)
  ).toBe(false);
});

test('a command response clears an unresponsive report while other commands remain pending', async () => {
  const transport = await load();
  const stalls: boolean[] = [];
  transport.subscribeStall((stalled) => stalls.push(stalled));
  void transport.send({ type: 'room_members', room_id: '!r:example.org' } as never).catch(() => {});
  void transport.send({ type: 'user_profile', user_id: '@u:example.org' }).catch(() => {});

  await vi.advanceTimersByTimeAsync(23_000);
  expect(stalls).toEqual([true]);

  FakeSharedWorker.last?.port.receive({ id: 1, err: { code: 'failed' } });
  expect(stalls).toEqual([true, false]);
});

test('a slow media fetch does not report the core as unresponsive', async () => {
  expect(
    await stalledFor((transport) => {
      void transport.fetchMedia('mxc://example.org/abc', 96, 96);
    })
  ).toBe(false);
});

test('resetCaches terminates the worker and wipes the browser storage', async () => {
  const deleted: string[] = [];
  vi.stubGlobal('indexedDB', {
    databases: () => Promise.resolve([{ name: 'sable-next-account-a1::matrix-sdk-state' }]),
    deleteDatabase(name: string) {
      deleted.push(name);
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
  });

  const transport = await load();
  void transport.send({ type: 'room_members', room_id: '!r:example.org' } as never).catch(() => {});

  await transport.resetCaches();

  expect(FakeSharedWorker.last?.port.posted).toContainEqual({ id: 2, reset: true });
  expect(deleted).toEqual(['sable-next-session', 'sable-next-account-a1::matrix-sdk-state']);
});
