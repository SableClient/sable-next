import { expect, test } from 'vitest';

import { alert, type PushPayload, unreadCount } from './push-payload';

function payload(notification: PushPayload['notification']): PushPayload {
  return { notification };
}

test('a counts-only push updates the badge and shows nothing', () => {
  const counts = payload({ counts: { unread: 4 } });

  expect(unreadCount(counts)).toBe(4);
  expect(alert(counts, null, true)).toBeNull();
  expect(unreadCount(payload({ room_id: '!room:example.org' }))).toBeNull();
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
