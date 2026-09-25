import { expect, test } from 'vitest';

import {
  parsePushPayload,
  alert,
  type PushPayload,
  silencedByRoomMode,
  unreadCount,
  webPushValidation,
} from './push-payload';

function payload(notification: PushPayload['notification']): PushPayload {
  return { notification };
}

function parsedPayload(raw: string): PushPayload {
  const parsed = parsePushPayload(raw);
  if (parsed === null) throw new Error('invalid push payload');
  return parsed;
}

test('a counts-only push updates the badge and shows nothing', () => {
  const counts = payload({ counts: { unread: 4 } });

  expect(unreadCount(counts)).toBe(4);
  expect(alert(counts, null, true)).toBeNull();
  expect(unreadCount(payload({ room_id: '!room:example.org' }))).toBeNull();
});

test('a flattened notification (MSC4174) reads its top-level unread', () => {
  const flattened = parsedPayload(
    JSON.stringify({
      room_id: '!room:example.org',
      event_id: '$event',
      user_id: '@me:example.org',
      unread: 2,
    })
  );

  expect(unreadCount(flattened)).toBe(2);
});

test('an event_id_only push names the room from what the app cached', () => {
  const showing = alert(
    payload({
      room_id: '!room:example.org',
      event_id: '$event',
      user_id: '@me:example.org',
      counts: { unread: 1 },
    }),
    'Design crew',
    true
  );

  expect(showing).toEqual({
    title: 'Design crew',
    body: 'New message',
    line: { sender: null, body: 'New message', eventId: '$event' },
    tag: '@me:example.org !room:example.org',
    roomId: '!room:example.org',
    eventId: '$event',
  });
});

test('a rich push prefers the name the server sent', () => {
  const showing = alert(
    payload({
      room_id: '!room:example.org',
      room_name: 'Design crew',
      sender_display_name: 'Ada',
      content: { body: 'shipped the patch' },
    }),
    'Stale name',
    true
  );

  expect(showing?.title).toBe('Design crew');
  expect(showing?.body).toBe('Ada: shipped the patch');
});

test('content stays out when the reader asked it to', () => {
  const rich = payload({
    room_id: '!room:example.org',
    sender_display_name: 'Ada',
    content: { body: 'shipped the patch' },
  });

  expect(alert(rich, null, false)?.body).toBe('New message from Ada');
});

test('an invitation says so rather than reading as a message', () => {
  const invite = payload({
    room_id: '!room:example.org',
    type: 'm.room.member',
    sender_display_name: 'Ada',
    content: { membership: 'invite' },
  });

  expect(alert(invite, 'Design crew', true)?.body).toBe('Ada invited you');
});

test('an unnamed room falls back rather than showing a room id', () => {
  expect(alert(payload({ room_id: '!room:example.org' }), null, true)?.title).toBe('Sable');
});

test.each(['flat', 'object', 'string'])('gateway %s payloads retain the recipient', (wrapper) => {
  const notification = { room_id: '!room:example.org', event_id: '$event' };
  const raw =
    wrapper === 'flat'
      ? { ...notification, user_id: '@me:example.org' }
      : {
          user_id: '@me:example.org',
          notification: wrapper === 'string' ? JSON.stringify(notification) : notification,
        };
  const parsed = parsedPayload(JSON.stringify(raw));
  expect(alert(parsed, null, true)?.tag).toBe('@me:example.org !room:example.org');
});

test('device metadata identifies a forwarded Matrix push', () => {
  const parsed = parsedPayload(
    JSON.stringify({
      notification: {
        room_id: '!room:example.org',
        devices: [{ data: { default_payload: { user_id: '@me:example.org' } } }],
      },
    })
  );
  expect(alert(parsed, null, true)?.tag).toBe('@me:example.org !room:example.org');
});

test('malformed and conflicting gateway payloads are rejected', () => {
  for (const raw of [
    'invalid',
    '[]',
    'null',
    '{"notification":null}',
    JSON.stringify({
      user_id: '@a:example.org',
      notification: { user_id: '@b:example.org', room_id: '!r:example.org' },
    }),
  ])
    expect(parsePushPayload(raw)).toBeNull();
});

const validation = JSON.stringify({ app_id: 'moe.sable.webpush', ack_token: 'tok' });

test('the MSC4174 validation push is not a notification', () => {
  expect(parsePushPayload(validation)).toBeNull();
  expect(webPushValidation(validation)).toEqual({
    appId: 'moe.sable.webpush',
    ackToken: 'tok',
  });
});

test('a notification carrying the same fields is still a notification', () => {
  const notification = JSON.stringify({
    app_id: 'moe.sable.webpush',
    ack_token: 'tok',
    room_id: '!room:example.org',
    event_id: '$event',
  });

  expect(webPushValidation(notification)).toBeNull();
  expect(parsedPayload(notification).notification?.room_id).toBe('!room:example.org');
});

test('an unparseable or incomplete handshake acknowledges nothing', () => {
  expect(webPushValidation(undefined)).toBeNull();
  expect(webPushValidation('not json')).toBeNull();
  expect(webPushValidation(JSON.stringify({ app_id: 'moe.sable.webpush' }))).toBeNull();
  expect(webPushValidation(JSON.stringify({ app_id: '', ack_token: 'tok' }))).toBeNull();
  expect(
    webPushValidation(JSON.stringify({ app_id: 'a', ack_token: 'tok', unread: 0 }))
  ).toBeNull();
});

test('a push renders no preview while the reader has previews off', () => {
  const message = payload({
    room_id: '!room:example.org',
    event_id: '$event',
    sender_display_name: 'Ada',
    content: { body: 'the merger closes friday' },
  });

  const hidden = alert(message, 'Design crew', false);
  expect(hidden?.body).toBe('New message from Ada');
  expect(hidden?.line.body).toBe('New message from Ada');

  expect(alert(message, 'Design crew', true)?.body).toBe('Ada: the merger closes friday');
});

test('an encrypted push is silenced in a room that only wants mentions', () => {
  const encrypted = payload({ room_id: '!room:example.org', type: 'm.room.encrypted' });
  const plain = payload({ room_id: '!room:example.org', type: 'm.room.message' });

  expect(silencedByRoomMode(encrypted, 'mentions')).toBe(true);
  expect(silencedByRoomMode(plain, 'mentions')).toBe(false);
  expect(silencedByRoomMode(encrypted, 'all')).toBe(false);
  expect(silencedByRoomMode(encrypted, null)).toBe(false);
  expect(silencedByRoomMode(plain, 'mute')).toBe(true);
});
