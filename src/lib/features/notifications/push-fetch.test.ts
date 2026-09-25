import { expect, test, vi } from 'vitest';

import type { PushFetchView } from '#src/generated/protocol';

import {
  completePushPayload,
  namesOnlyItsEvent,
  type PushFetcher,
  readPushFetch,
} from './push-fetch';
import type { PushPayload } from './push-payload';

const ROOM = '!room:example.org';
const bare: PushPayload = {
  notification: { room_id: ROOM, event_id: '$event', user_id: '@me:example.org', counts: {} },
};

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
  expect(
    namesOnlyItsEvent({ notification: { ...bare.notification, type: 'm.room.message' } })
  ).toBe(false);
  expect(namesOnlyItsEvent({ notification: { room_id: ROOM, counts: {} } })).toBe(false);
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

  expect(completed?.notification).toMatchObject({
    type: 'm.room.message',
    content: { body: 'hello' },
    sender_display_name: 'Alice',
    room_name: 'Garden',
  });
  expect(source.fetch.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: 'Bearer token' },
  });
});

test('a room with no name is titled after its sender, unless the app stored one', async () => {
  const responses = {
    [`${base}/event/$event`]: { type: 'm.room.message', sender: '@alice:example.org', content: {} },
  };

  expect((await completePushPayload(bare, fetcher(responses)))?.notification?.room_name).toBe(
    '@alice:example.org'
  );
  expect(
    (await completePushPayload(bare, fetcher(responses, null, 'Stored')))?.notification?.room_name
  ).toBe('Stored');
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
          room_name: 'Alice',
          room_avatar_url: null,
        },
      }
    )
  );

  expect(completed?.notification).toMatchObject({
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

  expect((await completePushPayload(bare, fetcher(responses)))?.notification?.type).toBe(
    'm.room.encrypted'
  );
  expect(await completePushPayload(bare, fetcher(responses, { kind: 'discard' }))).toBeNull();
});

test('a failed fetch leaves the payload as it arrived', async () => {
  expect(await completePushPayload(bare, fetcher({}))).toBe(bare);
});

test('a tab answer is only trusted in the shape the core sends', () => {
  expect(readPushFetch({ kind: 'discard' })).toEqual({ kind: 'discard' });
  expect(readPushFetch({ kind: 'unavailable' })).toBeNull();
  expect(readPushFetch({ kind: 'event', event: { type: 'm.room.message' } })).toBeNull();
  expect(readPushFetch(null)).toBeNull();
});
