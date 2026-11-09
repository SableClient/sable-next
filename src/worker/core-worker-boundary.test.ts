import { attachmentBytes } from '../transport/attachment-bytes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

function fakeCore(call: WorkerCore['call'] = () => Promise.resolve('null')): WorkerCore {
  return {
    call,
    fetchMedia: () => Promise.resolve(new Uint8Array(new ArrayBuffer())),
    forgetMedia: () => Promise.resolve(),
    sendAttachment: () => Promise.resolve(),
    sendGallery: () => Promise.resolve(),
    uploadMedia: () => Promise.resolve(''),
    rtcData: () => Promise.resolve(new Uint8Array(new ArrayBuffer())),
    setActive: () => Promise.resolve(),
  };
}

test('forwards core span names and epoch timing to connected pages', () => {
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore()));
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  boundary.handleSpan('search.index_room_search', 1_794_000_000_125, 25.5);

  const expected = [
    {
      span: { name: 'search.index_room_search', startMs: 1_794_000_000_125, durationMs: 25.5 },
    },
  ];
  expect(first.messages).toEqual(expected);
  expect(second.messages).toEqual(expected);
});

test('a core rejecting with a bare payload keeps the protocol error', async () => {
  const boundary = createCoreWorkerBoundary(
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the wasm core rejects with the bare payload
    Promise.resolve(fakeCore(() => Promise.reject('{"code":"unknown_room"}')))
  );
  const port = new FakePort();
  boundary.connect(port);

  await port.send({ id: 1, call: { method: 'session.restore', params: {} } });

  expect(port.messages).toEqual([{ id: 1, err: { code: 'unknown_room' } }]);
});

test('a core rejecting with an Error carrying the payload keeps the protocol error', async () => {
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.reject(new Error('{"code":"unknown_room"}'))))
  );
  const port = new FakePort();
  boundary.connect(port);

  await port.send({ id: 1, call: { method: 'session.restore', params: {} } });

  expect(port.messages).toEqual([{ id: 1, err: { code: 'unknown_room' } }]);
});

test('a core rejecting with a plain message fails the command', async () => {
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.reject(new Error('the media is gone'))))
  );
  const port = new FakePort();
  boundary.connect(port);

  await port.send({ id: 1, call: { method: 'session.restore', params: {} } });

  expect(port.messages).toEqual([{ id: 1, err: { code: 'failed', log_id: 'the media is gone' } }]);
});

test.each([undefined, false, true])(
  'passes background=%s through to WASM media downloads',
  async (background) => {
    const core = fakeCore();
    const bytes = new Uint8Array([7]);
    const fetchMedia = vi.fn(() => Promise.resolve(bytes));
    core.fetchMedia = fetchMedia;
    const boundary = createCoreWorkerBoundary(Promise.resolve(core));
    const port = new FakePort();
    boundary.connect(port);
    await port.send({
      id: 1,
      media: { source: 'mxc://example.org/emote', width: 0, height: 0, background },
    });
    expect(fetchMedia).toHaveBeenCalledWith('mxc://example.org/emote', 0, 0, background ?? false);
    expect(port.messages).toEqual([{ id: 1, bytes }]);
  }
);

test('passes rich attachment captions and mentions to the WASM core', async () => {
  const core = fakeCore();
  const sendAttachment = vi.fn(() => Promise.resolve());
  core.sendAttachment = sendAttachment;
  const boundary = createCoreWorkerBoundary(Promise.resolve(core));
  const port = new FakePort();
  boundary.connect(port);
  const bytes = new Uint8Array([1]);
  const thumbnail = { bytes: new Uint8Array([255, 216, 255]), width: 800, height: 450 };
  const formattedCaption = '<a href="https://matrix.to/#/@one:example.org">One</a>';

  await port.send({
    id: 1,
    attachment: {
      roomId: '!room:example.org',
      filename: 'photo.png',
      mime: 'image/png',
      bytes,
      thumbnail,
      caption: 'One',
      inReplyTo: '$reply',
      silentReply: true,
      info: null,
      threadRoot: '$thread',
      formattedCaption,
      mentions: ['@one:example.org'],
      mentionsRoom: true,
      persona: null,
      spoiler: true,
    },
  });

  expect(sendAttachment).toHaveBeenCalledWith(
    JSON.stringify({
      room_id: '!room:example.org',
      filename: 'photo.png',
      mime: 'image/png',
      caption: 'One',
      in_reply_to: '$reply',
      silent_reply: true,
      info: null,
      thread_root: '$thread',
      formatted_caption: formattedCaption,
      mentions: ['@one:example.org'],
      mentions_room: true,
      persona: null,
      spoiler: true,
    }),
    attachmentBytes([{ bytes, thumbnail }])
  );
  expect(port.messages).toEqual([{ id: 1, uri: null }]);
});

test('asks the WASM core to forget a media source', async () => {
  const core = fakeCore();
  const forgetMedia = vi.fn(() => Promise.resolve());
  core.forgetMedia = forgetMedia;
  const boundary = createCoreWorkerBoundary(Promise.resolve(core));
  const port = new FakePort();
  boundary.connect(port);

  await port.send({ id: 1, forget: { source: 'mxc://example.org/broken' } });

  expect(forgetMedia).toHaveBeenCalledWith('mxc://example.org/broken');
  expect(port.messages).toEqual([{ id: 1, uri: null }]);
});

test('passes an RTC frame to the core and returns the reply bytes', async () => {
  const core = fakeCore();
  const rtcData = vi.fn(() => Promise.resolve(new Uint8Array([9, 8])));
  core.rtcData = rtcData;
  const boundary = createCoreWorkerBoundary(Promise.resolve(core));
  const port = new FakePort();
  boundary.connect(port);

  await port.send({ id: 1, rtc: { sessionId: 'session', frame: new Uint8Array([1, 2]) } });

  expect(rtcData).toHaveBeenCalledWith('session', new Uint8Array([1, 2]));
  expect(port.messages).toEqual([{ id: 1, bytes: new Uint8Array([9, 8]) }]);
});

test('passes gallery items and shared metadata to the WASM core', async () => {
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
  const thumbnail = { bytes: new Uint8Array([255, 216, 255]), width: 800, height: 450 };
  const core = fakeCore();
  const sendGallery = vi.fn(() => Promise.resolve());
  core.sendGallery = sendGallery;
  const boundary = createCoreWorkerBoundary(Promise.resolve(core));
  const port = new FakePort();
  boundary.connect(port);

  await port.send({
    id: 1,
    gallery: {
      roomId: '!room:example.org',
      attachments: [
        {
          filename: 'one.png',
          mime: 'image/png',
          bytes: new Uint8Array([1]),
          thumbnail,
          spoiler: true,
        },
        {
          filename: 'two.pdf',
          mime: 'application/pdf',
          bytes: new Uint8Array([2]),
        },
      ],
      caption: 'Weekend',
      formattedCaption: '<strong>Weekend</strong>',
      mentions: ['@one:example.org'],
      mentionsRoom: true,
      inReplyTo: '$reply',
      silentReply: true,
      threadRoot: '$thread',
      persona,
    },
  });

  expect(sendGallery).toHaveBeenCalledWith(
    JSON.stringify({
      room_id: '!room:example.org',
      attachments: [
        { filename: 'one.png', mime: 'image/png', info: null, spoiler: true },
        { filename: 'two.pdf', mime: 'application/pdf', info: null, spoiler: false },
      ],
      caption: 'Weekend',
      in_reply_to: '$reply',
      silent_reply: true,
      thread_root: '$thread',
      formatted_caption: '<strong>Weekend</strong>',
      mentions: ['@one:example.org'],
      mentions_room: true,
      persona,
    }),
    attachmentBytes([{ bytes: new Uint8Array([1]), thumbnail }, { bytes: new Uint8Array([2]) }])
  );
  expect(port.messages).toEqual([{ id: 1, uri: null }]);
});

test('answers a health probe while a core command is pending', async () => {
  const core = fakeCore();
  core.call = () => new Promise<string>(() => {});
  const boundary = createCoreWorkerBoundary(Promise.resolve(core));
  const port = new FakePort();
  boundary.connect(port);

  void port.send({
    id: 1,
    call: { method: 'members.list', params: { room_id: '!room', memberships: [] } },
  });
  await port.send({ id: 2, ping: true });

  expect(port.messages).toEqual([{ id: 2, pong: true }]);
});

const subscribeTimeline = (roomId: string) => ({
  method: 'timeline.subscribe',
  params: { room_id: roomId, focus: { kind: 'live' as const }, hidden_events: false },
});

test('sends the subscription snapshot before startup events buffered for its port', async () => {
  let emit = (() => {}) as (json: string) => void;
  const core = fakeCore((method) => {
    if (method === 'timeline.subscribe') {
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
      return Promise.resolve(JSON.stringify({ subscription: 7, items: [] }));
    }
    return Promise.resolve('null');
  });
  const boundary = createCoreWorkerBoundary(Promise.resolve(core));
  emit = boundary.handleEvent;
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  await first.send({ id: 1, call: subscribeTimeline('!room') });

  expect(first.messages).toEqual([
    { id: 1, ok: { subscription: 7, items: [] } },
    {
      events: [
        { type: 'timeline_pagination', subscription: 7, loading: true, reached_start: false },
      ],
    },
  ]);
  expect(second.messages).toEqual([]);
});

test('forwards a core batch as one message per port', async () => {
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve(JSON.stringify({ subscription: 7, items: [] }))))
  );
  const owner = new FakePort();
  boundary.connect(owner);
  await owner.send({ id: 1, call: subscribeTimeline('!room') });
  owner.messages.length = 0;

  boundary.handleEvent(
    JSON.stringify([
      { type: 'timeline_diff', subscription: 7, diffs: [] },
      { type: 'timeline_diff', subscription: 7, diffs: [] },
      { type: 'sync_status', status: 'running' },
      { type: 'timeline_pagination', subscription: 7, loading: false, reached_start: false },
    ])
  );

  expect(owner.messages).toEqual([
    { events: [{ type: 'sync_status', status: 'running' }] },
    {
      events: [
        { type: 'timeline_diff', subscription: 7, diffs: [] },
        { type: 'timeline_diff', subscription: 7, diffs: [] },
        { type: 'timeline_pagination', subscription: 7, loading: false, reached_start: false },
      ],
    },
  ]);
});

test.each([false, true])(
  'startup overflow resubscribes with a fresh snapshot (repeated: %s)',
  async (repeated) => {
    let emit = (() => {}) as (json: string) => void;
    let subscriptions = 0;
    const released: number[] = [];
    const core = fakeCore((method, params) => {
      if (method === 'timeline.unsubscribe') {
        const { subscription } = JSON.parse(params) as { subscription?: number };
        if (subscription === undefined) throw new Error('Missing subscription');
        released.push(subscription);
        return Promise.resolve('null');
      }
      subscriptions += 1;
      const subscription = subscriptions;
      const overflow = repeated || subscriptions === 1;
      emit(
        JSON.stringify(
          Array.from({ length: overflow ? 101 : 1 }, () => ({
            type: 'timeline_diff',
            subscription,
            diffs: [{ op: 'clear' }],
          }))
        )
      );
      return Promise.resolve(JSON.stringify({ subscription, items: [] }));
    });
    const boundary = createCoreWorkerBoundary(Promise.resolve(core));
    emit = boundary.handleEvent;
    const port = new FakePort();
    boundary.connect(port);
    await port.send({ id: 1, call: subscribeTimeline('!room') });
    expect(subscriptions).toBe(repeated ? 3 : 2);
    expect(released).toEqual(repeated ? [1, 2, 3] : [1]);
    if (repeated) {
      expect(port.messages).toHaveLength(1);
      expect(port.messages[0]).toHaveProperty('id', 1);
      expect(port.messages[0]).toHaveProperty('err.code', 'failed');
    } else {
      expect(port.messages).toEqual([
        { id: 1, ok: { subscription: 2, items: [] } },
        { events: [{ type: 'timeline_diff', subscription: 2, diffs: [{ op: 'clear' }] }] },
      ]);
    }
  }
);

test('denies cross-port pagination and unsubscribe without calling the core', async () => {
  const calls: string[] = [];
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(
      fakeCore((method) => {
        calls.push(method);
        return Promise.resolve(JSON.stringify({ subscription: 7, items: [] }));
      })
    )
  );
  const owner = new FakePort();
  const other = new FakePort();
  boundary.connect(owner);
  boundary.connect(other);
  await owner.send({ id: 1, call: subscribeTimeline('!room') });

  await other.send({
    id: 2,
    call: {
      method: 'timeline.paginate',
      params: { subscription: 7, direction: 'backward', count: 20 },
    },
  });
  await other.send({
    id: 3,
    call: { method: 'timeline.unsubscribe', params: { subscription: 7 } },
  });

  expect(calls).toHaveLength(1);
  expect(other.messages).toEqual([
    { id: 2, err: { code: 'denied' } },
    { id: 3, err: { code: 'denied' } },
  ]);
});

test('cleans up active and pending subscriptions when their ports close', async () => {
  let resolveSubscribe: ((value: string) => void) | undefined;
  const calls: { method: string; params: unknown }[] = [];
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(
      fakeCore((method, params) => {
        calls.push({ method, params: JSON.parse(params) });
        if (calls.length === 1)
          return Promise.resolve(JSON.stringify({ subscription: 7, items: [] }));
        if (calls.length === 2) return new Promise((resolve) => (resolveSubscribe = resolve));
        return Promise.resolve('null');
      })
    )
  );
  const active = new FakePort();
  const pending = new FakePort();
  boundary.connect(active);
  boundary.connect(pending);
  await active.send({ id: 1, call: subscribeTimeline('!active') });
  await pending.send({ id: 2, call: subscribeTimeline('!pending') });

  active.onmessageerror?.({} as MessageEvent);
  pending.onmessageerror?.({} as MessageEvent);
  resolveSubscribe?.(JSON.stringify({ subscription: 8, items: [] }));
  await new Promise((resolve) => setTimeout(resolve));

  expect(calls).toEqual([
    subscribeTimeline('!active'),
    subscribeTimeline('!pending'),
    { method: 'timeline.unsubscribe', params: { subscription: 7 } },
    { method: 'timeline.unsubscribe', params: { subscription: 8 } },
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
  await first.send({ id: 1, call: { method: 'session.restore', params: {} } });

  expect(second.messages).toEqual([{ panic: { message: 'index out of bounds' } }]);
  expect(first.messages).toEqual([
    { panic: { message: 'index out of bounds' } },
    { id: 1, err: { code: 'failed', log_id: 'core panicked: index out of bounds' } },
  ]);
});

test('a worker failure carries its own stack to the page', () => {
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(() => new Promise(() => {}))));
  const port = new FakePort();
  boundary.connect(port);

  boundary.handlePanic('worker error: Uncaught RangeError', 'RangeError\n    at loop (w.js:1:2)');

  expect(port.messages).toEqual([
    {
      panic: {
        message: 'worker error: Uncaught RangeError',
        stack: 'RangeError\n    at loop (w.js:1:2)',
      },
    },
  ]);
});

test('a panic forwards the wasm stack and debug image to every page', () => {
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(() => Promise.resolve('{}'))));
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);
  const stack = 'Error: panic\n    at sable.wasm:wasm-function[12]:0x1234';
  const wasm = {
    type: 'wasm' as const,
    code_file: 'https://sable.test/sable.wasm',
    code_id: '00112233445566778899aabbccddeeff',
    debug_id: '00112233445566778899aabbccddeeff0',
  };

  boundary.handlePanic('panic', stack, wasm);

  expect(first.messages).toEqual([{ panic: { message: 'panic', stack, wasm } }]);
  expect(second.messages).toEqual(first.messages);
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

test('the lines after a log entry stay attached to it', () => {
  vi.useFakeTimers();
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(() => Promise.resolve('{}'))));
  const port = new FakePort();
  boundary.connect(port);

  boundary.handleLog(
    'ERROR matrix_sdk_ui::sync_service: Error while processing encryption in sync service: Some(\n    Http(\n        timeout,\n    ),\n)\nINFO sable_core: next'
  );
  vi.advanceTimersByTime(250);

  expect(port.messages).toEqual([
    {
      logs: [
        'ERROR matrix_sdk_ui::sync_service: Error while processing encryption in sync service: Some(\n    Http(\n        timeout,\n    ),\n)',
        'INFO sable_core: next',
      ],
    },
  ]);
  vi.useRealTimers();
});

test('a line the core marked as reported starts its own entry', () => {
  vi.useFakeTimers();
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(() => Promise.resolve('{}'))));
  const port = new FakePort();
  boundary.connect(port);

  boundary.handleLog('ERROR matrix_sdk: first(\n    detail,\n)\n\u001eERROR sable_core: second');
  vi.advanceTimersByTime(250);

  expect(port.messages).toEqual([
    { logs: ['ERROR matrix_sdk: first(\n    detail,\n)', '\u001eERROR sable_core: second'] },
  ]);
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

test('a reset request stops the core before answering, then terminates the worker', async () => {
  const terminate = vi.fn();
  let answeredBeforeStop = false;
  const port = new FakePort();
  const stop = vi.fn(() => {
    answeredBeforeStop = port.messages.length > 0;
    return Promise.resolve();
  });
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve('{}'))),
    undefined,
    terminate,
    undefined,
    stop
  );
  boundary.connect(port);

  await port.onmessage?.({ data: { id: 1, reset: true } } as MessageEvent<WorkerRequest>);

  expect(stop).toHaveBeenCalledOnce();
  expect(answeredBeforeStop).toBe(false);
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

test('a logFilter request reaches the core', () => {
  const setLogFilter = vi.fn();
  const boundary = createCoreWorkerBoundary(
    Promise.resolve(fakeCore(() => Promise.resolve('{}'))),
    undefined,
    undefined,
    setLogFilter
  );
  const port = new FakePort();
  boundary.connect(port);

  port.onmessage?.({ data: { logFilter: 'debug' } } as MessageEvent<WorkerRequest>);

  expect(setLogFilter).toHaveBeenCalledWith('debug');
  expect(port.messages).toEqual([]);
});

test('a superseded worker tells every page', () => {
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(() => Promise.resolve('{}'))));
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  boundary.handleSuperseded();

  expect(first.messages).toEqual([{ superseded: true }]);
  expect(second.messages).toEqual([{ superseded: true }]);
});

describe('foreground across tabs', () => {
  const foregroundCalls = (call: ReturnType<typeof vi.fn<WorkerCore['call']>>) =>
    call.mock.calls
      .filter(([method]) => method === 'session.set_app_in_foreground')
      .map(([, params]) => (JSON.parse(params) as { foreground: boolean }).foreground);

  test('a hidden page cannot background the app while another page is visible', async () => {
    const call = vi.fn<WorkerCore['call']>(() => Promise.resolve('null'));
    const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(call)));
    const first = new FakePort();
    const second = new FakePort();
    boundary.connect(first);
    boundary.connect(second);
    await first.send({ visible: true });
    await second.send({ visible: false });
    await second.send({
      id: 1,
      call: { method: 'session.set_app_in_foreground', params: { foreground: false } },
    });
    expect(foregroundCalls(call)).toEqual([true]);
    expect(second.messages).toEqual([{ id: 1, ok: null }]);
  });

  test('closing the last visible page backgrounds the app', async () => {
    const call = vi.fn<WorkerCore['call']>(() => Promise.resolve('null'));
    const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore(call)));
    const first = new FakePort();
    const second = new FakePort();
    boundary.connect(first);
    boundary.connect(second);
    await first.send({ visible: true });
    await second.send({ visible: false });
    await first.send({ disconnect: true });
    expect(first.onmessage).toBeNull();
    await second.send({ visible: true });
    expect(foregroundCalls(call)).toEqual([true, false, true]);
  });

  test('cache reset drains foreground updates before closing the stores', async () => {
    const pending = Promise.withResolvers<string>();
    const call = vi.fn<WorkerCore['call']>(() => pending.promise);
    const stop = vi.fn(() => Promise.resolve());
    const boundary = createCoreWorkerBoundary(
      Promise.resolve(fakeCore(call)),
      undefined,
      undefined,
      undefined,
      stop
    );
    const port = new FakePort();
    boundary.connect(port);
    await port.send({ visible: true });
    const resetting = port.onmessage?.({
      data: { id: 2, reset: true },
    } as MessageEvent<WorkerRequest>);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    pending.resolve('null');
    await resetting;
    expect(stop).toHaveBeenCalledOnce();
    expect(port.onmessage).toBeNull();
  });
});

describe('sync activity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const core = fakeCore();
    const setActive = vi.fn(() => Promise.resolve());
    core.setActive = setActive;
    const boundary = createCoreWorkerBoundary(Promise.resolve(core));
    const first = new FakePort();
    const second = new FakePort();
    boundary.connect(first);
    boundary.connect(second);
    return { boundary, first, second, setActive };
  }

  const send = (port: FakePort, request: WorkerRequest) =>
    port.onmessage?.({ data: request } as MessageEvent<WorkerRequest>);

  test('keeps syncing while every tab is hidden or closed', async () => {
    const { first, second, setActive } = setup();

    send(first, { visible: false });
    send(second, { visible: false });
    send(second, { disconnect: true });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(setActive).not.toHaveBeenCalled();
  });

  test('a tab becoming visible retries sync at once', async () => {
    const { second, setActive } = setup();

    send(second, { visible: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(setActive).toHaveBeenCalledExactlyOnceWith(true);
  });
});
