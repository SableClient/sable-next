import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../worker/core.worker.ts?sharedworker&url', () => ({ default: 'core.worker.js' }));

class FakePort {
  onmessage: ((message: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  start(): void {}
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
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  vi.stubGlobal('self', { location: new URL('https://sable.test/room') });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function stalledFor(send: (transport: Awaited<ReturnType<typeof load>>) => void) {
  const transport = await load();
  let stalled = false;
  transport.subscribeStall((next: boolean) => {
    stalled = next;
  });
  send(transport);
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
});

test('a slow command reports the core as unresponsive', async () => {
  expect(
    await stalledFor((transport) => {
      void transport.send({ type: 'room_members', room_id: '!r:example.org' } as never);
    })
  ).toBe(true);
});

test('a slow media fetch does not report the core as unresponsive', async () => {
  expect(
    await stalledFor((transport) => {
      void transport.fetchMedia('mxc://example.org/abc', 96, 96);
    })
  ).toBe(false);
});
