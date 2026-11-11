import { expect, test, vi } from 'vitest';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { CoreError, transportFailure } from '#src/transport';
import { SableWidgetDriver } from './widget-driver.js';

test('returns the created IDs for messages, state events and redactions', async () => {
  const messages = {
    sendRawEvent: vi.fn().mockResolvedValue('$message'),
    sendRedaction: vi.fn().mockResolvedValue('$redaction'),
  };
  const rpc = { room_state: { sendEvent: vi.fn().mockResolvedValue('$state') } };
  const driver = new SableWidgetDriver(
    { rpc: { ...rpc, messages } } as unknown as CoreClient,
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
  expect(messages.sendRedaction).toHaveBeenCalledExactlyOnceWith({
    room_id: '!room:example.org',
    event_id: '$target',
    reason: 'removed',
  });
  await expect(driver.sendEvent('m.room.redaction', { redacts: 1 })).rejects.toThrow(
    'redaction without a target'
  );
  expect(messages.sendRedaction).toHaveBeenCalledTimes(1);
});

function driverWith(
  media: Record<string, unknown>,
  navigate = () => Promise.resolve(),
  rpc: Record<string, Record<string, unknown>> = {}
) {
  return new SableWidgetDriver(
    { media, rpc } as unknown as CoreClient,
    '!room:example.org',
    (caps) => Promise.resolve(caps),
    navigate
  );
}

function driverWithRpc(rpc: Record<string, Record<string, unknown>>) {
  return new SableWidgetDriver(
    { rpc } as unknown as CoreClient,
    '!room:example.org',
    (caps) => Promise.resolve(caps),
    () => Promise.resolve()
  );
}

test('sends sticky and delayed events to the viewed room unless told otherwise', async () => {
  const widgets = {
    sendStickyEvent: vi.fn().mockResolvedValue('$sticky'),
    sendDelayedEvent: vi.fn().mockResolvedValue('delay-1'),
  };
  const driver = driverWithRpc({ widgets });

  await expect(driver.sendStickyEvent(900_000, 'com.example.member', { a: 1 })).resolves.toEqual({
    roomId: '!room:example.org',
    eventId: '$sticky',
  });
  expect(widgets.sendStickyEvent).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_type: 'com.example.member',
    content: { a: 1 },
    sticky_duration_ms: 900_000,
  });

  await expect(
    driver.sendDelayedEvent(5_000, 'com.example.state', {}, 'key', '!other:example.org')
  ).resolves.toEqual({ roomId: '!other:example.org', delayId: 'delay-1' });
  expect(widgets.sendDelayedEvent).toHaveBeenLastCalledWith({
    room_id: '!other:example.org',
    event_type: 'com.example.state',
    state_key: 'key',
    content: {},
    delay_ms: 5_000,
    sticky_duration_ms: null,
  });

  await driver.sendDelayedStickyEvent(5_000, 60_000, 'com.example.member', {});
  expect(widgets.sendDelayedEvent).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    event_type: 'com.example.member',
    state_key: null,
    content: {},
    delay_ms: 5_000,
    sticky_duration_ms: 60_000,
  });
});

test('cancels, restarts and sends delayed events by id', async () => {
  const widgets = { restartDelayedEvent: vi.fn().mockResolvedValue(undefined) };
  const messages = {
    cancelScheduled: vi.fn().mockResolvedValue(undefined),
    sendScheduled: vi.fn().mockResolvedValue(undefined),
  };
  const driver = driverWithRpc({ messages, widgets });

  await driver.cancelScheduledDelayedEvent('d1');
  await driver.restartScheduledDelayedEvent('d2');
  await driver.sendScheduledDelayedEvent('d3');

  expect(messages.cancelScheduled).toHaveBeenCalledWith({ delay_id: 'd1' });
  expect(widgets.restartDelayedEvent).toHaveBeenCalledWith({ delay_id: 'd2' });
  expect(messages.sendScheduled).toHaveBeenCalledWith({ delay_id: 'd3' });
});

test('forwards to-device messages with their encryption flag', async () => {
  const widgets = { sendToDevice: vi.fn().mockResolvedValue(undefined) };
  const driver = driverWithRpc({ widgets });
  const messages = { '@a:x': { '*': { key: 'value' } } };

  await driver.sendToDevice('com.example.ping', true, messages);

  expect(widgets.sendToDevice).toHaveBeenCalledWith({
    event_type: 'com.example.ping',
    encrypted: true,
    messages,
  });
});

test('reads room account data from the viewed room, or from every known room for the wildcard', async () => {
  const rpc = {
    room_state: {
      accountDataRaw: vi.fn(({ room_id }: { room_id: string }) =>
        Promise.resolve(
          room_id === '!gap:example.org' ? null : { type: 'com.example.data', room_id, content: {} }
        )
      ),
    },
  };
  const driver = new SableWidgetDriver(
    { rpc } as unknown as CoreClient,
    '!room:example.org',
    (caps) => Promise.resolve(caps),
    () => Promise.resolve()
  );
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
  const timeline = {
    roomEventRelations: vi.fn().mockResolvedValue({
      chunk: [{ event_id: '$reply' }],
      next_batch: 'next',
      prev_batch: null,
    }),
  };
  const driver = driverWith({}, undefined, { timeline });

  await expect(
    driver.readEventRelations('$parent', undefined, 'm.thread', 'm.room.message', 'a', 'b', 5, 'f')
  ).resolves.toEqual({
    chunk: [{ event_id: '$reply' }],
    nextBatch: 'next',
    prevBatch: undefined,
  });
  expect(timeline.roomEventRelations).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_id: '$parent',
    rel_type: 'm.thread',
    event_type: 'm.room.message',
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
    const calls = {
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
    const servers = driverWithRpc({ calls }).getTurnServers();

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
    expect(calls.turnServer).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('reports the media limit under the MSC4039 key', async () => {
  const driver = driverWith({}, undefined, {
    messages: { mediaConfig: vi.fn().mockResolvedValue({ upload_size: 1024 }) },
  });

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
  const calls = {
    rtcLivekit,
    rtcTransports: vi.fn().mockResolvedValue({ rtc_transports: [{ type: 'livekit' }] }),
  };
  const driver = driverWithRpc({ calls });
  const request = {
    server_name: 'example.org',
    url: 'wss://sfu.example.org',
    room_id: '!room:example.org',
    slot_id: 'm.call#ROOM',
    member_id: 'm1',
  };

  await expect(driver.getRtcTransports()).resolves.toEqual({
    rtc_transports: [{ type: 'livekit' }],
  });
  await expect(driver.getRtcLivekitToken(request)).resolves.toEqual({ jwt: 'token' });
  await driver.delegateRtcLivekitDelayedLeave({
    url: request.url,
    room_id: request.room_id,
    slot_id: request.slot_id,
    member_id: request.member_id,
    delay_id: 'd1',
  });

  expect(rtcLivekit).toHaveBeenNthCalledWith(1, { endpoint: 'get_token', body: request });
  expect(rtcLivekit).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ endpoint: 'delegate_delayed_leave' })
  );
});

test('expresses core refusals as Matrix API errors', () => {
  const driver = driverWith({});

  expect(driver.processError(new CoreError({ code: 'unsupported' }))).toMatchObject({
    matrix_api_error: { http_status: 404, response: { errcode: 'M_UNRECOGNIZED' } },
  });
  expect(driver.processError(new CoreError({ code: 'denied' }))).toMatchObject({
    matrix_api_error: { http_status: 403, response: { errcode: 'M_FORBIDDEN' } },
  });
  expect(driver.processError(new CoreError(transportFailure('e1')))).toBeUndefined();
  expect(driver.processError(new Error('boom'))).toBeUndefined();
});

test('offers no TURN servers when the homeserver has none', async () => {
  const driver = driverWithRpc({
    calls: {
      turnServer: vi.fn().mockResolvedValue({ uris: [], username: '', password: '', ttl_ms: 0 }),
    },
  });

  await expect(driver.getTurnServers().next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

test('a widget searching the directory sees real names, never nicknames', async () => {
  const driver = driverWithRpc({
    account: {
      searchUserDirectory: vi.fn().mockResolvedValue({
        limited: false,
        results: [
          {
            user_id: '@bob:example.org',
            display_name: 'Bobby',
            avatar_url: 'mxc://example.org/nick',
            real_name: 'Bob',
            real_avatar_url: 'mxc://example.org/real',
          },
        ],
      }),
    },
  });

  await expect(driver.searchUserDirectory('bob')).resolves.toEqual({
    limited: false,
    results: [
      { userId: '@bob:example.org', displayName: 'Bob', avatarUrl: 'mxc://example.org/real' },
    ],
  });
});
