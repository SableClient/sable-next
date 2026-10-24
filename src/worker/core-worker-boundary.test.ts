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
    setActive: () => Promise.resolve(),
  };
}

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

test('passes gallery items and shared metadata to the WASM core', async () => {
  const persona = {
    id: 'kris',
    display_name: 'Kris',
    avatar_url: null,
    pronouns: [],
    color_on_light: null,
    color_on_dark: null,
    has_fallback: false,
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
        { filename: 'one.png', mime: 'image/png', info: null },
        { filename: 'two.pdf', mime: 'application/pdf', info: null },
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

test('forwards a core batch to every port as one message', () => {
  const boundary = createCoreWorkerBoundary(Promise.resolve(fakeCore()));
  const first = new FakePort();
  const second = new FakePort();
  boundary.connect(first);
  boundary.connect(second);

  boundary.handleEvent(
    JSON.stringify([{ type: 'sync_status', status: 'running' }, { type: 'inbox_changed' }])
  );

  const batch = {
    events: [{ type: 'sync_status', status: 'running' }, { type: 'inbox_changed' }],
  };
  expect(first.messages).toEqual([batch]);
  expect(second.messages).toEqual([batch]);
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

  test('a returning network retries sync even with every tab hidden', async () => {
    const { boundary, first, second, setActive } = setup();
    send(first, { visible: false });
    send(second, { visible: false });

    boundary.handleOnline();
    await vi.advanceTimersByTimeAsync(0);

    expect(setActive).toHaveBeenCalledExactlyOnceWith(true);
  });
});
