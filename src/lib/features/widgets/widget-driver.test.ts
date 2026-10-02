import { expect, test, vi } from 'vitest';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { CoreError } from '#src/transport';
import { SableWidgetDriver } from './widget-driver.js';

test('returns the created IDs for messages, state events and redactions', async () => {
  const commands = {
    sendRawEvent: vi.fn().mockResolvedValue('$message'),
    sendStateEvent: vi.fn().mockResolvedValue('$state'),
    sendRedaction: vi.fn().mockResolvedValue('$redaction'),
  };
  const driver = new SableWidgetDriver(
    { commands } as unknown as CoreClient,
    '!room:example.org',
    (caps) => Promise.resolve(caps),
    () => Promise.resolve()
  );
  await expect(driver.sendEvent('com.example.message', {})).resolves.toEqual({
    roomId: '!room:example.org',
    eventId: '$message',
  });
  await expect(
    driver.sendEvent('com.example.state', {}, '', '!other:example.org')
  ).resolves.toEqual({ roomId: '!other:example.org', eventId: '$state' });
  await expect(
    driver.sendEvent('m.room.redaction', { redacts: '$target', reason: 'removed' })
  ).resolves.toEqual({ roomId: '!room:example.org', eventId: '$redaction' });
  expect(commands.sendRedaction).toHaveBeenCalledExactlyOnceWith(
    '!room:example.org',
    '$target',
    'removed'
  );
  await expect(driver.sendEvent('m.room.redaction', { redacts: 1 })).rejects.toThrow(
    'redaction without a target'
  );
  expect(commands.sendRedaction).toHaveBeenCalledTimes(1);
});

function driverWith(commands: Record<string, unknown>, navigate = () => Promise.resolve()) {
  return new SableWidgetDriver(
    { commands } as unknown as CoreClient,
    '!room:example.org',
    (caps) => Promise.resolve(caps),
    navigate
  );
}

test('sends sticky and delayed events to the viewed room unless told otherwise', async () => {
  const commands = {
    widgetSendStickyEvent: vi.fn().mockResolvedValue('$sticky'),
    widgetSendDelayedEvent: vi.fn().mockResolvedValue('delay-1'),
  };
  const driver = driverWith(commands);

  await expect(driver.sendStickyEvent(900_000, 'com.example.member', { a: 1 })).resolves.toEqual({
    roomId: '!room:example.org',
    eventId: '$sticky',
  });
  expect(commands.widgetSendStickyEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'com.example.member',
    { a: 1 },
    900_000
  );

  await expect(
    driver.sendDelayedEvent(5_000, 'com.example.state', {}, 'key', '!other:example.org')
  ).resolves.toEqual({ roomId: '!other:example.org', delayId: 'delay-1' });
  expect(commands.widgetSendDelayedEvent).toHaveBeenLastCalledWith(
    '!other:example.org',
    'com.example.state',
    'key',
    {},
    5_000,
    null
  );

  await driver.sendDelayedStickyEvent(5_000, 60_000, 'com.example.member', {});
  expect(commands.widgetSendDelayedEvent).toHaveBeenLastCalledWith(
    '!room:example.org',
    'com.example.member',
    null,
    {},
    5_000,
    60_000
  );
});

test('cancels, restarts and sends delayed events by id', async () => {
  const commands = {
    cancelScheduledMessage: vi.fn().mockResolvedValue(undefined),
    restartDelayedEvent: vi.fn().mockResolvedValue(undefined),
    sendScheduledMessage: vi.fn().mockResolvedValue(undefined),
  };
  const driver = driverWith(commands);

  await driver.cancelScheduledDelayedEvent('d1');
  await driver.restartScheduledDelayedEvent('d2');
  await driver.sendScheduledDelayedEvent('d3');

  expect(commands.cancelScheduledMessage).toHaveBeenCalledWith('d1');
  expect(commands.restartDelayedEvent).toHaveBeenCalledWith('d2');
  expect(commands.sendScheduledMessage).toHaveBeenCalledWith('d3');
});

test('forwards to-device messages with their encryption flag', async () => {
  const commands = { widgetSendToDevice: vi.fn().mockResolvedValue(undefined) };
  const driver = driverWith(commands);
  const messages = { '@a:x': { '*': { key: 'value' } } };

  await driver.sendToDevice('com.example.ping', true, messages);

  expect(commands.widgetSendToDevice).toHaveBeenCalledWith('com.example.ping', true, messages);
});

test('reads room account data from the viewed room, or from every known room for the wildcard', async () => {
  const commands = {
    roomAccountDataRaw: vi.fn((roomId: string) =>
      Promise.resolve(
        roomId === '!gap:example.org'
          ? null
          : { type: 'com.example.data', room_id: roomId, content: {} }
      )
    ),
  };
  const driver = driverWith(commands);
  driver.noteRooms(['!a:example.org', '!gap:example.org']);

  await expect(driver.readRoomAccountData('com.example.data')).resolves.toEqual([
    { type: 'com.example.data', room_id: '!room:example.org', content: {} },
  ]);
  const everywhere = await driver.readRoomAccountData('com.example.data', ['*']);
  expect(everywhere.map((event) => event.room_id)).toEqual(['!room:example.org', '!a:example.org']);
  expect(driver.getKnownRooms()).toEqual([
    '!room:example.org',
    '!a:example.org',
    '!gap:example.org',
  ]);
});

test('maps the relations read onto the widget result and the direction onto the core', async () => {
  const commands = {
    roomEventRelations: vi.fn().mockResolvedValue({
      chunk: [{ event_id: '$reply' }],
      next_batch: 'next',
      prev_batch: null,
    }),
  };
  const driver = driverWith(commands);

  await expect(
    driver.readEventRelations('$parent', undefined, 'm.thread', 'm.room.message', 'a', 'b', 5, 'f')
  ).resolves.toEqual({
    chunk: [{ event_id: '$reply' }],
    nextBatch: 'next',
    prevBatch: undefined,
  });
  expect(commands.roomEventRelations).toHaveBeenCalledWith('!room:example.org', '$parent', {
    relType: 'm.thread',
    eventType: 'm.room.message',
    from: 'a',
    to: 'b',
    limit: 5,
    direction: 'forward',
  });
});

test('navigates with the matrix.to fragment and refuses anything else', async () => {
  const navigate = vi.fn().mockResolvedValue(undefined);
  const driver = driverWith({}, navigate);

  await driver.navigate('https://matrix.to/#/!room%3Aexample.org?via=example.org');
  expect(navigate).toHaveBeenCalledWith('!room%3Aexample.org?via=example.org');

  await expect(driver.navigate('https://example.org/#/!room')).rejects.toThrow(
    'Invalid matrix.to URI'
  );
  expect(navigate).toHaveBeenCalledTimes(1);
});

test('keeps the TURN credentials fresh until the widget stops watching', async () => {
  vi.useFakeTimers();
  try {
    const commands = {
      turnServer: vi
        .fn()
        .mockResolvedValueOnce({
          uris: ['turn:a'],
          username: 'u1',
          password: 'p1',
          ttl_ms: 3_600_000,
        })
        .mockResolvedValueOnce({
          uris: ['turn:b'],
          username: 'u2',
          password: 'p2',
          ttl_ms: 3_600_000,
        }),
    };
    const servers = driverWith(commands).getTurnServers();

    await expect(servers.next()).resolves.toEqual({
      done: false,
      value: { uris: ['turn:a'], username: 'u1', password: 'p1' },
    });
    const second = servers.next();
    await vi.advanceTimersByTimeAsync(3_600_000 * 0.9);
    await expect(second).resolves.toEqual({
      done: false,
      value: { uris: ['turn:b'], username: 'u2', password: 'p2' },
    });
    expect(commands.turnServer).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('reports the media limit under the MSC4039 key', async () => {
  const driver = driverWith({ mediaConfig: vi.fn().mockResolvedValue({ upload_size: 1024 }) });

  await expect(driver.getMediaConfig()).resolves.toEqual({ 'm.upload.size': 1024 });
});

test('uploads a blob with its type and refuses a body it cannot read', async () => {
  const uploadMedia = vi.fn().mockResolvedValue('mxc://example.org/abc');
  const driver = driverWith({ uploadMedia });

  await expect(
    driver.uploadFile(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
  ).resolves.toEqual({ contentUri: 'mxc://example.org/abc' });
  expect(uploadMedia).toHaveBeenCalledWith('image/png', new Uint8Array([1, 2, 3]));

  await expect(driver.uploadFile(new FormData())).rejects.toThrow('unsupported upload body');
  expect(uploadMedia).toHaveBeenCalledTimes(1);
});

test('downloads the original of a content URI', async () => {
  const fetchMedia = vi.fn().mockResolvedValue(new Uint8Array([9, 8]));
  const driver = driverWith({ fetchMedia });

  const { file } = await driver.downloadFile('mxc://example.org/abc');

  expect(fetchMedia).toHaveBeenCalledWith('mxc://example.org/abc', 0, 0);
  expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(new Uint8Array([9, 8]));
});

test('relays the RTC requests to the core verbatim', async () => {
  const rtcLivekit = vi.fn().mockResolvedValue({ jwt: 'token' });
  const commands = {
    rtcLivekit,
    rtcTransports: vi.fn().mockResolvedValue({ rtc_transports: [{ type: 'livekit' }] }),
  };
  const driver = driverWith(commands);
  const request = {
    server_name: 'example.org',
    url: 'wss://sfu.example.org',
    room_id: '!room:example.org',
    slot_id: 'm.call#ROOM',
    member: { id: 'm1' },
  };

  await expect(driver.getRtcTransports()).resolves.toEqual({
    rtc_transports: [{ type: 'livekit' }],
  });
  await expect(driver.getRtcLivekitToken(request)).resolves.toEqual({ jwt: 'token' });
  await driver.delegateRtcLivekitDelayedLeave({
    room_id: request.room_id,
    slot_id: request.slot_id,
    member: request.member,
    delay_id: 'd1',
  });

  expect(rtcLivekit).toHaveBeenNthCalledWith(1, 'get_token', request);
  expect(rtcLivekit).toHaveBeenNthCalledWith(2, 'delegate_delayed_leave', expect.anything());
});

test('expresses core refusals as Matrix API errors', () => {
  const driver = driverWith({});

  expect(driver.processError(new CoreError({ code: 'unsupported' }))).toMatchObject({
    matrix_api_error: { http_status: 404, response: { errcode: 'M_UNRECOGNIZED' } },
  });
  expect(driver.processError(new CoreError({ code: 'denied' }))).toMatchObject({
    matrix_api_error: { http_status: 403, response: { errcode: 'M_FORBIDDEN' } },
  });
  expect(driver.processError(new CoreError({ code: 'failed', log_id: 'e1' }))).toBeUndefined();
  expect(driver.processError(new Error('boom'))).toBeUndefined();
});

test('offers no TURN servers when the homeserver has none', async () => {
  const driver = driverWith({
    turnServer: vi.fn().mockResolvedValue({ uris: [], username: '', password: '', ttl_ms: 0 }),
  });

  await expect(driver.getTurnServers().next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});
