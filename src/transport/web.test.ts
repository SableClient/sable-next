import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../worker/core.worker.ts?sharedworker&url', () => ({ default: 'core.worker.js' }));
vi.mock('#src/generated/wasm/sable_wasm_version.js', () => ({ default: 'test-wasm-version' }));

const { captureException, addBreadcrumb, startSpan, startInactiveSpan, endCoreSpan } = vi.hoisted(
  () => ({
    captureException: vi.fn<(error: unknown, context?: unknown) => void>(),
    addBreadcrumb: vi.fn<(breadcrumb: unknown) => void>(),
    endCoreSpan: vi.fn(),
    startSpan: vi.fn<typeof import('@sentry/sveltekit').startSpan>(),
    startInactiveSpan: vi.fn<typeof import('@sentry/sveltekit').startInactiveSpan>(),
  })
);
vi.mock('@sentry/sveltekit', async (importOriginal) => {
  const sentry = await importOriginal<typeof import('@sentry/sveltekit')>();
  return {
    ...sentry,
    captureException,
    addBreadcrumb,
    startSpan: startSpan.mockImplementation(sentry.startSpan),
    startInactiveSpan: startInactiveSpan.mockImplementation((options) => {
      const span = sentry.startInactiveSpan(options);
      vi.spyOn(span, 'end').mockImplementation(endCoreSpan);
      return span;
    }),
  };
});

class FakePort {
  onmessage: ((message: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  transfers: Transferable[][] = [];
  respondToPings = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push(message);
    this.transfers.push(transfer);
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

class FakeSharedWorker extends EventTarget {
  static last: FakeSharedWorker | null = null;
  static created = 0;
  port = new FakePort();
  url: URL;
  name: string | undefined;

  constructor(url: string | URL, options?: WorkerOptions) {
    super();
    this.url = new URL(url);
    this.name = options?.name;
    FakeSharedWorker.last = this;
    FakeSharedWorker.created += 1;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  FakeSharedWorker.last = null;
  FakeSharedWorker.created = 0;
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  vi.stubGlobal('self', { location: new URL('https://sable.test/room') });
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

test('creates one RPC span per call with only the method name', async () => {
  const transport = await load();
  const first = transport.call('members.list', { room_id: '!private:example.org' });
  const second = transport.call('account.user_profile', { user_id: '@private:example.org' });

  expect(startSpan.mock.calls.map(([options]) => options)).toEqual([
    { name: 'members.list', op: 'rpc.core' },
    { name: 'account.user_profile', op: 'rpc.core' },
  ]);
  FakeSharedWorker.last?.port.receive({ id: 2, ok: { display_name: 'Name' } });
  FakeSharedWorker.last?.port.receive({ id: 1, ok: [] });
  await expect(first).resolves.toEqual([]);
  await expect(second).resolves.toEqual({ display_name: 'Name' });
  transport.close();
});

test('keeps an RPC rejection inside its span', async () => {
  const transport = await load();
  const pending = transport.call('timeline.unsubscribe', { subscription: 1 });
  const result = expect(pending).rejects.toThrow();
  FakeSharedWorker.last?.port.receive({ id: 1, err: { code: 'unknown_subscription' } });

  await result;
  expect(startSpan).toHaveBeenCalledExactlyOnceWith(
    { name: 'timeline.unsubscribe', op: 'rpc.core' },
    expect.any(Function)
  );
  transport.close();
});

test('does not create RPC spans for health pings or internal messages', async () => {
  const transport = await load();
  const pending = transport.call('members.list', {});
  await vi.advanceTimersByTimeAsync(20_001);
  expect(FakeSharedWorker.last?.port.posted).toContainEqual({ id: 2, ping: true });
  FakeSharedWorker.last?.port.receive({ id: 2, pong: true });
  transport.setDebugLogs(true);
  const media = transport.fetchMedia('mxc://example.org/file', 0, 0);
  FakeSharedWorker.last?.port.receive({ id: 3, bytes: new Uint8Array([1]) });
  await media;
  FakeSharedWorker.last?.port.receive({ id: 1, ok: [] });
  await pending;
  transport.close();

  expect(startSpan).toHaveBeenCalledTimes(1);
  expect(startInactiveSpan).not.toHaveBeenCalled();
});

test('sends an RTC frame to the worker and resolves with the reply bytes', async () => {
  const transport = await load();
  const reply = transport.rtcData('session', new Uint8Array([1, 2]));
  expect(FakeSharedWorker.last?.port.posted).toContainEqual({
    id: 1,
    rtc: { sessionId: 'session', frame: new Uint8Array([1, 2]) },
  });
  FakeSharedWorker.last?.port.receive({ id: 1, bytes: new Uint8Array([3]) });
  await expect(reply).resolves.toEqual(new Uint8Array([3]));
  transport.close();
});

test('records forwarded core spans using worker epoch timestamps in seconds', async () => {
  const transport = await load();
  const pending = transport.call('members.list', {});
  const startMs = 1_794_000_000_125;
  vi.setSystemTime(startMs + 5_000);
  FakeSharedWorker.last?.port.receive({
    span: { name: 'view.enrich_rooms', startMs, durationMs: 12.5 },
  });

  expect(startInactiveSpan).toHaveBeenCalledExactlyOnceWith({
    name: 'view.enrich_rooms',
    op: 'core.task',
    startTime: startMs / 1_000,
  });
  expect(endCoreSpan).toHaveBeenCalledExactlyOnceWith((startMs + 12.5) / 1_000);
  FakeSharedWorker.last?.port.receive({ id: 1, ok: [] });
  await pending;
  transport.close();
});

test('uses a WASM-specific worker URL', async () => {
  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' });

  expect(FakeSharedWorker.last?.url.searchParams.get('wasm')).toBeTruthy();
}, 20_000);

test('adopts a prewarmed worker instead of opening a second one', async () => {
  const { createWebTransport, prewarmWebWorker } = await import('./web');
  prewarmWebWorker();
  prewarmWebWorker();
  expect(FakeSharedWorker.created).toBe(1);

  const transport = createWebTransport();
  void transport.call('members.list', { room_id: '!r:example.org' });

  expect(FakeSharedWorker.created).toBe(1);
  expect(FakeSharedWorker.last?.port.posted).toHaveLength(1);
});

test('a prewarmed worker that failed to load rejects the first request', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { createWebTransport, prewarmWebWorker } = await import('./web');
  prewarmWebWorker();
  FakeSharedWorker.last?.dispatchEvent(Object.assign(new Event('error'), { message: 'no module' }));

  const transport = createWebTransport();

  await expect(transport.call('members.list', { room_id: '!r:example.org' })).rejects.toThrow();
});

test('uses an in-memory event cache in an iOS PWA', async () => {
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)',
    standalone: true,
  });
  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' });

  expect(FakeSharedWorker.last?.url.searchParams.get('event-cache')).toBe('memory');
});

test('sends the log filter to the shared worker instead of forking it by URL', async () => {
  vi.stubGlobal('self', { location: new URL('https://sable.test/room?log=debug') });
  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' });

  expect(FakeSharedWorker.last?.url.searchParams.has('log')).toBe(false);
  expect(FakeSharedWorker.last?.port.posted).toContainEqual({ logFilter: 'debug' });
});

test('a superseded worker rejects pending work and is never reopened', async () => {
  const transport = await load();
  const superseded = vi.fn();
  transport.subscribeSuperseded?.(superseded);
  const pending = transport.call('members.list', { room_id: '!r:example.org' });

  FakeSharedWorker.last?.port.receive({ superseded: true });

  expect(superseded).toHaveBeenCalledOnce();
  await expect(pending).rejects.toThrow();
  await expect(transport.call('members.list', { room_id: '!r:example.org' })).rejects.toThrow();
  expect(FakeSharedWorker.created).toBe(1);
});

test('preserves rich attachment captions and mentions across the worker transport', async () => {
  const transport = await load();
  const attachment = {
    roomId: '!room:example.org',
    thumbnail: { bytes: new Uint8Array([255, 216, 255]), width: 800, height: 450 },
    filename: 'photo.png',
    mime: 'image/png',
    bytes: new Uint8Array([1]),
    caption: 'One',
    formattedCaption: '<a href="https://matrix.to/#/@one:example.org">One</a>',
    mentions: ['@one:example.org'],
    mentionsRoom: true,
    inReplyTo: '$reply',
    silentReply: false,
    info: null,
    threadRoot: '$thread',
    persona: null,
    spoiler: true,
  };
  const pending = transport.sendAttachment(attachment);
  expect(FakeSharedWorker.last?.port.posted).toContainEqual({ id: 1, attachment });
  expect(FakeSharedWorker.last?.port.transfers).toContainEqual([
    attachment.bytes.buffer,
    attachment.thumbnail.bytes.buffer,
  ]);
  FakeSharedWorker.last?.port.receive({ id: 1, uri: null });
  await pending;
  transport.close();
});

test.each([undefined, false, true])(
  'passes background=%s for media downloads',
  async (background) => {
    const transport = await load();
    const pending = transport.fetchMedia('mxc://example.org/emote', 0, 0, background);
    expect(FakeSharedWorker.last?.port.posted).toContainEqual({
      id: 1,
      media: {
        source: 'mxc://example.org/emote',
        width: 0,
        height: 0,
        background: background ?? false,
      },
    });
    FakeSharedWorker.last?.port.receive({ id: 1, bytes: new Uint8Array([7]) });
    await expect(pending).resolves.toEqual(new Uint8Array([7]));
    transport.close();
  }
);

test('sends a gallery as one worker request', async () => {
  const persona = {
    id: 'kris',
    display_name: 'Kris',
    avatar_url: null,
    pronouns: [],
    color_on_light: null,
    color_on_dark: null,
    has_fallback: false,
    biography: null,
    banner_url: null,
    is_animal: null,
    has_animal: null,
    animal_need: null,
  };
  const transport = await load();
  const first = new Uint8Array([1]);
  const thumbnail = { bytes: new Uint8Array([255, 216, 255]), width: 800, height: 450 };
  const second = new Uint8Array([2]);
  const pending = transport.sendGallery({
    roomId: '!room:example.org',
    attachments: [
      { filename: 'one.png', mime: 'image/png', bytes: first, thumbnail },
      {
        filename: 'two.pdf',
        mime: 'application/pdf',
        bytes: second,
      },
    ],
    caption: 'Weekend',
    formattedCaption: '<strong>Weekend</strong>',
    mentions: ['@one:example.org'],
    mentionsRoom: true,
    inReplyTo: '$reply',
    silentReply: false,
    threadRoot: '$thread',
    persona,
  });

  expect(FakeSharedWorker.last?.port.posted).toContainEqual({
    id: 1,
    gallery: {
      roomId: '!room:example.org',
      attachments: [
        { filename: 'one.png', mime: 'image/png', bytes: first, thumbnail },
        { filename: 'two.pdf', mime: 'application/pdf', bytes: second },
      ],
      caption: 'Weekend',
      formattedCaption: '<strong>Weekend</strong>',
      mentions: ['@one:example.org'],
      mentionsRoom: true,
      inReplyTo: '$reply',
      silentReply: false,
      threadRoot: '$thread',
      persona,
    },
  });
  expect(FakeSharedWorker.last?.port.transfers).toContainEqual([
    first.buffer,
    thumbnail.bytes.buffer,
    second.buffer,
  ]);
  FakeSharedWorker.last?.port.receive({ id: 1, uri: null });
  await pending;
  transport.close();
});

test('a slow command reports an unresponsive worker', async () => {
  expect(
    await stalledFor((transport) => {
      void transport.call('members.list', { room_id: '!r:example.org' });
    })
  ).toBe(true);
});

test('a slow command does not report a responsive worker as unresponsive', async () => {
  expect(
    await stalledFor((transport) => {
      void transport.call('members.list', { room_id: '!r:example.org' });
    }, true)
  ).toBe(false);
});

test('a command response clears an unresponsive report while other commands remain pending', async () => {
  const transport = await load();
  const stalls: boolean[] = [];
  transport.subscribeStall((stalled) => stalls.push(stalled));
  void transport.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  void transport.call('account.user_profile', { user_id: '@u:example.org' }).catch(() => {});

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

test('an interrupted IndexedDB transaction requests explicit recovery', async () => {
  const transport = await load();
  const interrupted = vi.fn();
  transport.subscribeStorageFailure?.(interrupted);
  void transport.call('members.list', { room_id: '!r:example.org' }).catch(() => {});

  FakeSharedWorker.last?.port.receive({
    logs: [
      'ERROR IndexedDB: Attempt to get records from database without an in-progress transaction',
    ],
  });

  expect(interrupted).toHaveBeenCalledOnce();
});

test('resetCaches terminates the worker and drops the cached stores', async () => {
  const deleted: string[] = [];
  vi.stubGlobal('indexedDB', {
    databases: () =>
      Promise.resolve([
        { name: 'sable-next-account-a1::event_cache' },
        { name: 'sable-next-account-a1::sable-search' },
      ]),
    deleteDatabase(name: string) {
      deleted.push(name);
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        request.onsuccess?.(new Event('success'));
      });
      return request;
    },
  });

  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' }).catch(() => {});

  await transport.resetCaches([]);

  expect(FakeSharedWorker.last?.port.posted).toContainEqual({ id: 2, reset: true });
  expect(deleted).toEqual(['sable-next-account-a1::event_cache']);
});

test('a worker crash reports the stack the worker sent, grouped on its message', async () => {
  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' }).catch(() => {});

  FakeSharedWorker.last?.port.receive({
    panic: {
      message: 'worker error: Uncaught RangeError',
      stack: 'RangeError\n    at loop (w.js:1:2)',
    },
  });

  const { Scope } = await import('@sentry/sveltekit');
  const [error, context] = captureException.mock.lastCall ?? [];
  expect((error as Error).message).toBe('worker error: Uncaught RangeError');
  expect((error as Error).stack).toBe('RangeError\n    at loop (w.js:1:2)');
  const scope = (context as (scope: InstanceType<typeof Scope>) => InstanceType<typeof Scope>)(
    new Scope()
  );
  expect(scope.getScopeData()).toMatchObject({
    fingerprint: ['wasm-core-crash', 'worker error: Uncaught RangeError'],
    eventProcessors: [],
  });
});

test('a Rust panic associates wasm addresses with its worker image in Sentry', async () => {
  const { Scope } = await import('@sentry/sveltekit');
  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  const wasm = {
    type: 'wasm' as const,
    code_file: 'https://sable.test/sable.wasm',
    code_id: '00112233445566778899aabbccddeeff',
    debug_id: '00112233445566778899aabbccddeeff0',
  };
  const stack = 'Error: panic\n    at https://sable.test/sable.wasm:wasm-function[12]:0x1234';
  FakeSharedWorker.last?.port.receive({ panic: { message: 'panic', stack, wasm } });

  const [error, context] = captureException.mock.lastCall ?? [];
  expect((error as Error).stack).toBe(stack);
  expect(context).toBeTypeOf('function');
  const scope = (context as (scope: InstanceType<typeof Scope>) => InstanceType<typeof Scope>)(
    new Scope()
  );
  expect(scope.getScopeData()).toMatchObject({
    fingerprint: ['wasm-core-crash', 'panic'],
    tags: { source: 'wasm-core' },
  });
  const event = {
    exception: {
      values: [
        {
          stacktrace: {
            frames: [
              { filename: 'https://sable.test/core.worker.js', lineno: 1 },
              { filename: 'https://sable.test/sable.wasm:wasm-function[12]:0x1234' },
              { filename: 'wasm://wasm/01234567:wasm-function[13]:0x5678' },
              { filename: 'https://sable.test/other.wasm:wasm-function[1]:0x10' },
            ],
          },
        },
      ],
    },
    debug_meta: {
      images: [{ type: 'sourcemap' as const, code_file: 'worker.js', debug_id: 'js-id' }],
    },
  };
  const processor = scope.getScopeData().eventProcessors.at(-1);
  expect(await processor?.(event, {})).toMatchObject({
    exception: {
      values: [
        {
          stacktrace: {
            frames: [
              { filename: 'https://sable.test/core.worker.js', lineno: 1 },
              {
                filename: wasm.code_file,
                platform: 'native',
                instruction_addr: '0x1234',
                addr_mode: 'rel:1',
              },
              {
                filename: wasm.code_file,
                platform: 'native',
                instruction_addr: '0x5678',
                addr_mode: 'rel:1',
              },
              { filename: 'https://sable.test/other.wasm:wasm-function[1]:0x10' },
            ],
          },
        },
      ],
    },
    debug_meta: { images: [...event.debug_meta.images.slice(0, 1), wasm] },
  });
});

test('a panicked worker is replaced under a new name', async () => {
  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  const panicked = FakeSharedWorker.last;
  expect(panicked?.name).toBe('sable-core');

  panicked?.port.receive({ panic: { message: 'failed to remove an event' } });
  void transport.call('members.list', { room_id: '!r:example.org' }).catch(() => {});

  expect(FakeSharedWorker.last).not.toBe(panicked);
  expect(FakeSharedWorker.last?.name).toBe('sable-core-1');
});

test('a page opened after a panic uses the new name, and each panic moves it on', async () => {
  const first = await load();
  void first.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  FakeSharedWorker.last?.port.receive({ panic: { message: 'first panic' } });

  vi.resetModules();
  const reloaded = await load();
  void reloaded.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  expect(FakeSharedWorker.last?.name).toBe('sable-core-1');

  FakeSharedWorker.last?.port.receive({ panic: { message: 'second panic' } });
  void reloaded.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  expect(FakeSharedWorker.last?.name).toBe('sable-core-2');
});

test('tabs that crash on the same worker agree on the next one', async () => {
  const first = await load();
  void first.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  const firstWorker = FakeSharedWorker.last;
  const second = await load();
  void second.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  const secondWorker = FakeSharedWorker.last;

  firstWorker?.port.receive({ panic: { message: 'shared panic' } });
  secondWorker?.port.receive({ panic: { message: 'shared panic' } });
  void first.call('members.list', { room_id: '!r:example.org' }).catch(() => {});
  const firstNext = FakeSharedWorker.last;
  void second.call('members.list', { room_id: '!r:example.org' }).catch(() => {});

  expect(firstNext?.name).toBe('sable-core-1');
  expect(FakeSharedWorker.last?.name).toBe('sable-core-1');
});

test('a worker startup failure rejects restore and allows a new worker', async () => {
  const transport = await load();
  const crashed = vi.fn();
  transport.subscribeCrash(crashed);
  const restored = transport.call('session.restore', {}).catch((error: unknown) => error);
  const failed = FakeSharedWorker.last;
  failed?.dispatchEvent(new Event('error'));
  await Promise.resolve();
  expect(crashed).toHaveBeenCalledTimes(1);
  expect(await restored).toBeInstanceOf(Error);
  const retry = transport.call('session.restore', {}).catch(() => undefined);
  expect(FakeSharedWorker.last).not.toBe(failed);
  failed?.dispatchEvent(new Event('error'));
  expect(crashed).toHaveBeenCalledTimes(1);
  transport.close();
  await retry;
});

test('reports new core errors after twenty distinct failures', async () => {
  const transport = await load();
  const restored = transport.call('session.restore', {}).catch(() => undefined);
  captureException.mockClear();
  const logs = Array.from(
    { length: 26 },
    (_, index) => `\u001eERROR sable_core: failure_${String.fromCharCode(97 + index)}`
  );
  FakeSharedWorker.last?.port.receive({ logs });
  expect(captureException).toHaveBeenCalledTimes(26);
  FakeSharedWorker.last?.port.receive({ logs });
  expect(captureException).toHaveBeenCalledTimes(26);
  transport.close();
  await restored;
});

test('reports an undecryptable message once per megolm session, grouped together', async () => {
  const transport = await load();
  const restored = transport.call('session.restore', {}).catch(() => undefined);
  captureException.mockClear();
  const utd = (session: string) =>
    `\u001eWARN sable_core::utd: unable to decrypt a message reported=true cause=Unknown megolm_session="${session}"`;
  FakeSharedWorker.last?.port.receive({ logs: [utd('0a1b2c3d4e5f'), utd('0a1b2c3d4e5f')] });
  FakeSharedWorker.last?.port.receive({ logs: [utd('ffeeddccbbaa')] });
  expect(captureException).toHaveBeenCalledTimes(2);
  const [first, second] = captureException.mock.calls.map(
    ([, context]) => (context as { fingerprint: string[] }).fingerprint
  );
  expect(first).toEqual(second);
  transport.close();
  await restored;
});

test('keeps errors that are not ours as breadcrumbs', async () => {
  const transport = await load();
  const restored = transport.call('session.restore', {}).catch(() => undefined);
  captureException.mockClear();
  addBreadcrumb.mockClear();
  FakeSharedWorker.last?.port.receive({
    logs: [
      'ERROR matrix_sdk_ui::sync_service: Error while processing room list',
      'WARN matrix_sdk_crypto::gossiping::machine: key request from an unknown device',
    ],
  });
  expect(captureException).not.toHaveBeenCalled();
  expect(addBreadcrumb).toHaveBeenCalledTimes(2);
  transport.close();
  await restored;
});

test('tells the worker whether the page is visible, on connect and on every change', async () => {
  const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  vi.stubGlobal('document', page);
  const transport = await load();
  void transport.call('members.list', { room_id: '!r:example.org' });
  const port = FakeSharedWorker.last?.port;

  expect(port?.posted).toContainEqual({ visible: false });

  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));

  expect(port?.posted).toContainEqual({ visible: true });
});
