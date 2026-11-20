import { expect, test, vi } from 'vitest';

import type { PushFetchView } from '#src/generated/protocol';

import {
  acknowledgeWebPusher,
  completePushPayload,
  fetchDeviceActivity,
  isRtcInvite,
  namesOnlyItsEvent,
  readPushRooms,
  type PushFetcher,
  readPushFetch,
} from './push-fetch';
import { pushNotification } from '#lib/notifications/push-fixtures.js';

const ROOM = '!room:example.org';
const bare = pushNotification({ room_id: ROOM, event_id: '$event', user_id: '@me:example.org' });

function fetcher(
  responses: Record<string, unknown>,
  decrypt: PushFetchView | null = null,
  roomName: string | null = null
): PushFetcher & { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn((url: string) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const body = responses[path];
    return Promise.resolve(
      body === undefined ? new Response(null, { status: 404 }) : Response.json(body)
    );
  });
  return {
    session: {
      userId: '@me:example.org',
      deviceId: 'DEVICE',
      homeserver: 'https://hs.example/',
      accessToken: 'token',
    },
    fetch,
    roomName: () => Promise.resolve(roomName),
    decrypt: () => Promise.resolve(decrypt),
  } as PushFetcher & { fetch: ReturnType<typeof vi.fn> };
}

const base = `/_matrix/client/v3/rooms/${ROOM}`;

test('only a push that names nothing but its event is fetched', () => {
  expect(namesOnlyItsEvent(bare)).toBe(true);
  expect(namesOnlyItsEvent({ ...bare, type: 'm.room.message' })).toBe(false);
  expect(namesOnlyItsEvent(pushNotification({ room_id: ROOM }))).toBe(false);
});

test('read room reconciliation uses filtered sync counts and fails closed', async () => {
  const source = fetcher({
    '/_matrix/client/v3/sync': {
      next_batch: 's',
      rooms: {
        join: {
          '!read:example.org': { unread_notifications: { notification_count: 0 } },
          '!unread:example.org': { unread_notifications: { notification_count: 2 } },
          '!missing-count:example.org': {},
        },
      },
    },
  });
  await expect(
    readPushRooms(source, [
      '!read:example.org',
      '!unread:example.org',
      '!left:example.org',
      '!missing-count:example.org',
    ])
  ).resolves.toEqual(['!read:example.org', '!left:example.org', '!missing-count:example.org']);
  expect(source.fetch.mock.calls[0]?.[0]).toContain('set_presence=offline');
  expect(source.fetch.mock.calls[0]?.[0]).toContain('timeout=0');

  source.fetch.mockResolvedValue(Response.json({ next_batch: 's', rooms: { join: [] } }));
  await expect(readPushRooms(source, ['!read:example.org'])).resolves.toBeNull();
});

test('a plaintext event is completed with its sender and room, with the token', async () => {
  const source = fetcher({
    [`${base}/event/$event`]: {
      type: 'm.room.message',
      sender: '@alice:example.org',
      content: { msgtype: 'm.text', body: 'hello' },
    },
    [`${base}/state/m.room.member/@alice:example.org`]: { displayname: 'Alice' },
    [`${base}/state/m.room.name/`]: { name: 'Garden' },
  });

  const completed = await completePushPayload(bare, source);

  expect(completed).toMatchObject({
    type: 'm.room.message',
    content: { body: 'hello' },
    sender_display_name: 'Alice',
    room_name: 'Garden',
  });
  expect(source.fetch.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: 'Bearer token' },
  });
});

test.each(['', '   ', '\u200b\u2800\ufeff'])(
  'a hidden push sender name uses the user ID (%j)',
  async (displayname) => {
    const completed = await completePushPayload(
      bare,
      fetcher({
        [`${base}/event/$event`]: {
          type: 'm.room.message',
          sender: '@alice:example.org',
          content: { body: 'hello' },
        },
        [`${base}/state/m.room.member/@alice:example.org`]: { displayname },
      })
    );

    expect(completed?.sender_display_name).toBe('@alice:example.org');
  }
);

test.each([false, true])('fetches rich text as plain text (encrypted: %s)', async (encrypted) => {
  const content = {
    msgtype: 'm.text',
    body: '<a data-mention-type="user" href="https://matrix.to/#/@alice:example.org" contenteditable="false">Alice</a> hi &amp; welcome',
    format: 'org.matrix.custom.html',
    formatted_body: '<a href="https://matrix.to/#/@alice:example.org">Alice</a> hi &amp; welcome',
  };
  const completed = await completePushPayload(
    bare,
    fetcher(
      {
        [`${base}/event/$event`]: {
          type: encrypted ? 'm.room.encrypted' : 'm.room.message',
          sender: '@alice:example.org',
          content: encrypted ? { ciphertext: 'x' } : content,
        },
      },
      {
        kind: 'event',
        event: {
          type: 'm.room.message',
          content,
          sender: '@alice:example.org',
          sender_display_name: 'Alice',
          sender_avatar_url: null,
          room_name: 'Garden',
          room_avatar_url: null,
          encrypted: true,
          noisy: false,
          mention: false,
        },
      }
    )
  );
  expect(completed?.content.body).toBe('Alice hi & welcome');
});

test('a room with no name is titled after its sender, unless the app stored one', async () => {
  const responses = {
    [`${base}/event/$event`]: { type: 'm.room.message', sender: '@alice:example.org', content: {} },
  };

  expect((await completePushPayload(bare, fetcher(responses)))?.room_name).toBe(
    '@alice:example.org'
  );
  expect((await completePushPayload(bare, fetcher(responses, null, 'Stored')))?.room_name).toBe(
    'Stored'
  );
});

test('an encrypted event takes what the open tab decrypted, and remembers it was encrypted', async () => {
  const completed = await completePushPayload(
    bare,
    fetcher(
      {
        [`${base}/event/$event`]: {
          type: 'm.room.encrypted',
          sender: '@alice:example.org',
          content: { ciphertext: 'x' },
        },
      },
      {
        kind: 'event',
        event: {
          type: 'm.room.message',
          content: { body: 'secret' },
          sender: '@alice:example.org',
          sender_display_name: 'Alice',
          sender_avatar_url: null,
          room_name: 'Alice',
          room_avatar_url: null,
          encrypted: true,
          noisy: false,
          mention: false,
        },
      }
    )
  );

  expect(completed).toMatchObject({
    type: 'm.room.message',
    content: { body: 'secret' },
    decrypted: true,
  });
});

test('an encrypted event no tab could read stays encrypted, and a silenced one is dropped', async () => {
  const responses = {
    [`${base}/event/$event`]: {
      type: 'm.room.encrypted',
      sender: '@alice:example.org',
      content: { ciphertext: 'x' },
    },
  };

  expect((await completePushPayload(bare, fetcher(responses)))?.type).toBe('m.room.encrypted');
  expect(await completePushPayload(bare, fetcher(responses, { kind: 'discard' }))).toBeNull();
});

test.each([403, 404])(
  'an event the server answers %i for is an invitation to a room not yet joined',
  async (status) => {
    const forbidden = fetcher({}, null, 'Design crew');
    forbidden.fetch.mockResolvedValue(new Response(null, { status }));

    const completed = await completePushPayload(bare, forbidden);

    expect(completed).toMatchObject({
      type: 'm.room.member',
      content: { membership: 'invite' },
      room_name: 'Design crew',
    });
  }
);

test.each([500, 'offline'])(
  'a fetch that fails with %s leaves the payload as it arrived',
  async (failure) => {
    const failing = fetcher({});
    if (typeof failure === 'number') {
      failing.fetch.mockResolvedValue(new Response(null, { status: failure }));
    } else {
      failing.fetch.mockRejectedValue(new Error(failure));
    }
    expect(await completePushPayload(bare, failing)).toBe(bare);
  }
);

test('a tab answer is only trusted in the shape the core sends', () => {
  expect(readPushFetch({ kind: 'discard' })).toEqual({ kind: 'discard' });
  expect(readPushFetch({ kind: 'unavailable' })).toBeNull();
  expect(readPushFetch({ kind: 'event', event: { type: 'm.room.message' } })).toBeNull();
  expect(readPushFetch(null)).toBeNull();
});

const session = {
  userId: '@me:example.org',
  deviceId: 'DEVICE',
  homeserver: 'https://hs.example/',
  accessToken: 't',
};
const validation = { app_id: 'moe.sable.webpush', ack_token: 'tok' };

test('the worker acknowledges a web push validation with the stored session', async () => {
  const send = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));

  await expect(acknowledgeWebPusher(session, validation, send)).resolves.toBe(true);

  const [url, init] = send.mock.calls[0] ?? [];
  expect(url).toBe('https://hs.example/_matrix/client/unstable/org.matrix.msc4174/pushers/ack');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer t');
  expect(JSON.parse(init?.body as string)).toEqual(validation);
});

test('a rejected acknowledgement is final and left for an open tab', async () => {
  const send = vi.fn(() => Promise.resolve(Response.json({}, { status: 400 })));

  await expect(acknowledgeWebPusher(session, validation, send)).resolves.toBe(false);
  expect(send).toHaveBeenCalledOnce();
});

test('an unreachable homeserver is asked again before giving up', async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json({}, { status: 502 }))
    .mockResolvedValueOnce(Response.json({}));
  const pause = vi.fn(() => Promise.resolve());

  await expect(acknowledgeWebPusher(session, validation, send, pause)).resolves.toBe(true);
  expect(send).toHaveBeenCalledTimes(3);
  expect(pause).toHaveBeenCalledTimes(2);
});

test('reads device activity, or null when the server refuses', async () => {
  const activity = { devices: { DEVICE: { active: true, at: 1000 } } };
  const answering = fetcher({
    '/_matrix/client/v3/user/@me:example.org/account_data/moe.sable.device_activity': activity,
  });
  await expect(fetchDeviceActivity(answering)).resolves.toEqual(activity);
  expect(answering.fetch.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: 'Bearer token' },
  });

  await expect(fetchDeviceActivity(fetcher({}))).resolves.toBeNull();
});

test('an RTC push must identify its room and event before presentation', async () => {
  const source = fetcher({});
  for (const missing of [{ room_id: null }, { event_id: null }]) {
    expect(
      await completePushPayload({ ...bare, type: 'm.rtc.invite', ...missing }, source)
    ).toBeNull();
  }
  expect(source.fetch).not.toHaveBeenCalled();
});

test('RTC payloads request validation even when the push includes content', () => {
  for (const type of [
    'm.rtc.invite',
    'm.rtc.notification',
    'org.matrix.msc4075.rtc.notification',
  ]) {
    expect(isRtcInvite({ type })).toBe(true);
  }
  expect(isRtcInvite({ type: 'm.room.message' })).toBe(false);
});

function rtcSnapshot(event: Record<string, unknown>, status = 'open', withdrawn = false): unknown {
  const now = Date.now();
  const events = [event];
  if (withdrawn)
    events.push({
      ...event,
      event_id: '$withdrawal',
      origin_server_ts: now,
      content: { sticky_key: 'm.call#room' },
    });
  return {
    pos: 'push-state',
    rooms: {
      [ROOM]: {
        required_state: [
          {
            type: 'm.rtc.slot',
            state_key: 'm.call#room',
            content: { status, application: { type: 'm.call' } },
          },
          {
            type: 'm.room.power_levels',
            state_key: '',
            content: { users_default: 0, notifications: { room: 50 } },
          },
        ],
      },
    },
    extensions: { 'org.matrix.msc4354.sticky_events': { rooms: { [ROOM]: { events } } } },
  };
}

function rtcEvent(): Record<string, unknown> {
  const sent = Date.now() - 3000;
  return {
    type: 'm.rtc.invite',
    event_id: '$event',
    sender: '@alice:example.org',
    origin_server_ts: sent,
    sticky: { duration_ms: 300000 },
    content: {
      slot_id: 'm.call#room',
      sticky_key: 'm.call#room',
      sender_ts: sent,
      lifetime: 90000,
      'm.mentions': { user_ids: ['@me:example.org'] },
    },
  };
}

const stickyPath = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';

test.each([true, false])(
  'plaintext RTC push works without an app tab (direct=%j)',
  async (direct) => {
    const event = rtcEvent();
    const source = fetcher({
      [`${base}/event/$event`]: event,
      [stickyPath]: rtcSnapshot(event),
      '/_matrix/client/v3/user/@me:example.org/account_data/m.direct': direct
        ? { '@alice:example.org': [ROOM] }
        : {},
    });
    const completed = await completePushPayload({ ...bare, type: 'm.rtc.invite' }, source);
    expect(completed?.content).toMatchObject({
      notification_type: 'ring',
      body: 'Call started',
    });
    const request = source.fetch.mock.calls.find(([url]) =>
      String(url).includes('simplified_msc3575')
    );
    expect(request?.[1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });
  }
);

test('legacy group rings retain their explicit presentation', async () => {
  const event = rtcEvent();
  event.type = 'org.matrix.msc4075.rtc.notification';
  event.content = {
    sender_ts: Date.now() - 3000,
    lifetime: 30000,
    notification_type: 'ring',
    'm.mentions': { user_ids: ['@me:example.org'] },
  };
  const source = fetcher({
    [`${base}/event/$event`]: event,
    [stickyPath]: rtcSnapshot(event),
  });
  expect((await completePushPayload(bare, source))?.content.notification_type).toBe('ring');
});

test('deployed non-sticky call pushes work without sliding sync or direct room data', async () => {
  const event = rtcEvent();
  event.type = 'org.matrix.msc4075.rtc.notification';
  delete event.sticky;
  event.content = {
    slot_id: 'm.call#ROOM',
    msc4354_sticky_key: 'm.call#ROOM',
    sender_ts: Date.now() - 3000,
    lifetime: 90000,
    notification_type: 'ring',
    'm.mentions': { user_ids: ['@me:example.org'] },
  };
  const source = fetcher({
    [`${base}/event/$event`]: event,
    [`${base}/state`]: [],
  });
  expect((await completePushPayload(bare, source))?.content.notification_type).toBe('ring');
  expect(source.fetch.mock.calls.some(([url]) => String(url).includes('simplified_msc3575'))).toBe(
    false
  );
});

test.each(['closed', 'withdrawn', 'unavailable'])(
  'an inactive RTC push is discarded (%s)',
  async (reason) => {
    const event = rtcEvent();
    const source = fetcher({
      [`${base}/event/$event`]: event,
      ...(reason === 'unavailable'
        ? {}
        : {
            [stickyPath]: rtcSnapshot(
              event,
              reason === 'closed' ? 'closed' : 'open',
              reason === 'withdrawn'
            ),
          }),
    });
    expect(await completePushPayload({ ...bare, type: 'm.rtc.invite' }, source)).toBeNull();
  }
);

test('an app tab supplies already validated RTC presentation', async () => {
  const event = rtcEvent();
  const source = fetcher(
    { [`${base}/event/$event`]: event },
    {
      kind: 'event',
      event: {
        type: 'm.rtc.invite',
        content: { notification_type: 'ring', lifetime: 85000 },
        sender: '@alice:example.org',
        sender_display_name: 'Alice',
        sender_avatar_url: null,
        room_name: 'Room',
        room_avatar_url: null,
        encrypted: false,
        noisy: true,
        mention: false,
      },
    }
  );
  expect((await completePushPayload(bare, source))?.content.notification_type).toBe('ring');
  expect(source.fetch.mock.calls.some(([url]) => String(url).includes('simplified_msc3575'))).toBe(
    false
  );
});
