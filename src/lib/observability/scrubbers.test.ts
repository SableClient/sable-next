import { describe, expect, it } from 'vitest';

import {
  omitIdentifierFields,
  sanitizePayload,
  scrubDataObject,
  scrubExternalHosts,
  scrubMatrixIds,
  scrubMatrixUrl,
} from './scrubbers';

describe('scrubExternalHosts', () => {
  it('replaces an external https origin', () => {
    expect(scrubExternalHosts('https://matrix.example.org/_matrix/client/v3/sync')).toBe(
      'https://[HOMESERVER]/_matrix/client/v3/sync'
    );
  });

  it('replaces an external http origin and drops the port', () => {
    expect(scrubExternalHosts('http://hs.corp.local:8448/_matrix/')).toBe(
      'http://[HOMESERVER]/_matrix/'
    );
  });

  it('preserves localhost origins', () => {
    const dev = 'http://localhost:3000/home';
    expect(scrubExternalHosts(dev)).toBe(dev);
  });

  it('preserves the tauri app origin', () => {
    const app = 'https://tauri.localhost/index.html';
    expect(scrubExternalHosts(app)).toBe(app);
  });

  it('leaves non-http schemes alone', () => {
    expect(scrubExternalHosts('tauri://localhost/index.html')).toBe('tauri://localhost/index.html');
  });

  it('leaves origin-less paths alone', () => {
    expect(scrubExternalHosts('/_matrix/client/v3/sync')).toBe('/_matrix/client/v3/sync');
  });

  it('scrubs every URL in one string', () => {
    expect(scrubExternalHosts('fetch https://hs.one/sync then https://hs.two/media')).toBe(
      'fetch https://[HOMESERVER]/sync then https://[HOMESERVER]/media'
    );
  });
});

describe('scrubMatrixIds', () => {
  it('redacts an access token in query-string form', () => {
    expect(scrubMatrixIds('GET /?access_token=abc123xyz')).toBe('GET /?access_token=[REDACTED]');
  });

  it('redacts passwords, refresh tokens and sync tokens', () => {
    expect(scrubMatrixIds('password=hunter2')).toBe('password=[REDACTED]');
    expect(scrubMatrixIds('refresh_token=tok_refresh_xyz')).toBe('refresh_token=[REDACTED]');
    expect(scrubMatrixIds('next_batch=s1234_5678')).toBe('next_batch=[REDACTED]');
  });

  it('matches token names case-insensitively', () => {
    expect(scrubMatrixIds('Access_Token=abc')).toBe('Access_Token=[REDACTED]');
  });

  it('leaves unrelated query params alone', () => {
    expect(scrubMatrixIds('format=json&limit=50')).toBe('format=json&limit=50');
  });

  it('replaces user IDs, room IDs and aliases', () => {
    expect(scrubMatrixIds('@alice:example.com')).toBe('@[USER_ID]');
    expect(scrubMatrixIds('!roomid:example.com')).toBe('![ROOM_ID]');
    expect(scrubMatrixIds('#general:example.com')).toBe('#[ROOM_ALIAS]');
  });

  it('replaces event IDs of ten characters or more', () => {
    expect(scrubMatrixIds('$abcdefghij')).toBe('$[EVENT_ID]');
    expect(scrubMatrixIds('$short')).toBe('$short');
  });

  it('scrubs several IDs in one string', () => {
    const result = scrubMatrixIds('User @alice:example.com joined !abc:example.com');
    expect(result).toBe('User @[USER_ID] joined ![ROOM_ID]');
  });

  it('passes through a string with nothing sensitive', () => {
    const safe = 'Something went wrong loading the timeline';
    expect(scrubMatrixIds(safe)).toBe(safe);
  });
});

describe('scrubDataObject', () => {
  it('scrubs strings at the top level, nested, and in arrays', () => {
    expect(scrubDataObject('@alice:example.com')).toBe('@[USER_ID]');
    expect(scrubDataObject({ context: { room: '!room:example.com' } })).toEqual({
      context: { room: '![ROOM_ID]' },
    });
    expect(scrubDataObject(['@alice:example.com', 42])).toEqual(['@[USER_ID]', 42]);
  });

  it('leaves non-strings untouched', () => {
    expect(scrubDataObject(null)).toBeNull();
    expect(scrubDataObject(42)).toBe(42);
    expect(scrubDataObject(true)).toBe(true);
    expect(scrubDataObject({})).toEqual({});
  });
});

describe('scrubMatrixUrl', () => {
  it('scrubs Matrix client-server API paths', () => {
    expect(scrubMatrixUrl('/_matrix/client/v3/rooms/!abc:example.com/messages')).toBe(
      '/_matrix/client/v3/rooms/![ROOM_ID]/messages'
    );
    expect(scrubMatrixUrl('/rooms/!abc:example.com/event/$eventIdHere')).toContain(
      '/event/$[EVENT_ID]'
    );
    expect(scrubMatrixUrl('/rooms/!abc:example.com/relations/$eventIdHere')).toContain(
      '/relations/$[EVENT_ID]'
    );
    expect(scrubMatrixUrl('/_matrix/client/v3/profile/@alice:example.com')).toBe(
      '/_matrix/client/v3/profile/[USER_ID]'
    );
    expect(scrubMatrixUrl('/profile/%40alice%3Aexample.com')).toBe('/profile/[USER_ID]');
    expect(scrubMatrixUrl('/_matrix/client/v3/user/@alice:example.com/filter')).toBe(
      '/_matrix/client/v3/user/[USER_ID]/filter'
    );
    expect(scrubMatrixUrl('/_matrix/client/v3/presence/@alice:example.com/status')).toBe(
      '/_matrix/client/v3/presence/[USER_ID]/status'
    );
    expect(scrubMatrixUrl('/_matrix/client/v3/room_keys/keys/latest')).toBe(
      '/_matrix/client/v3/room_keys/keys/[REDACTED]'
    );
    expect(scrubMatrixUrl('/sendToDevice/m.room.encrypted/txnId123')).toBe(
      '/sendToDevice/m.room.encrypted/[TXN_ID]'
    );
  });

  it('scrubs media paths in both the current and legacy shapes', () => {
    expect(scrubMatrixUrl('/_matrix/client/v1/media/download/matrix.org/someMediaId')).toBe(
      '/_matrix/client/v1/media/download/[SERVER]/[MEDIA_ID]'
    );
    expect(scrubMatrixUrl('/_matrix/media/v3/download/matrix.org/someMediaId')).toBe(
      '/_matrix/media/v3/download/[SERVER]/[MEDIA_ID]'
    );
  });

  it('scrubs the host and the path of a full URL', () => {
    expect(
      scrubMatrixUrl('https://matrix.example.org/_matrix/client/v3/rooms/!abc:example.com/messages')
    ).toBe('https://[HOMESERVER]/_matrix/client/v3/rooms/![ROOM_ID]/messages');
  });

  it("scrubs the app's own route segments", () => {
    expect(scrubMatrixUrl('/rooms/!roomid:example.com')).toBe('/rooms/![ROOM_ID]');
    expect(scrubMatrixUrl('/rooms/!roomid%3Aexample.com')).toBe('/rooms/![ROOM_ID]');
    expect(scrubMatrixUrl('/rooms/#general:example.com')).toBe('/rooms/[ROOM_ALIAS]');
    expect(scrubMatrixUrl('/home/!roomid:example.com')).toBe('/home/![ROOM_ID]');
    expect(scrubMatrixUrl('/home/!roomid%3Aexample.com')).toBe('/home/![ROOM_ID]');
    expect(scrubMatrixUrl('/direct/@alice:example.com')).toBe('/direct/@[USER_ID]');
    expect(scrubMatrixUrl('/home/#general:example.com')).toBe('/home/[ROOM_ALIAS]');
  });

  it('scrubs percent-encoded deep links', () => {
    expect(scrubMatrixUrl('/to/%40alice%3Aexample.com')).toBe('/to/[USER_ID]');
    expect(scrubMatrixUrl('/to/%21room%3Aexample.com')).toBe('/to/![ROOM_ID]');
    expect(scrubMatrixUrl('/to/%23general%3Aexample.com')).toBe('/to/[ROOM_ALIAS]');
    expect(scrubMatrixUrl('/to/%24eventIdLongEnough')).toBe('/to/[EVENT_ID]');
  });

  it('strips the query string from preview_url', () => {
    expect(scrubMatrixUrl('/_matrix/media/v3/preview_url?url=https://example.com&ts=1')).toBe(
      '/_matrix/media/v3/preview_url'
    );
  });

  it('redacts auth callback credentials', () => {
    expect(scrubMatrixUrl('https://app.example/login/hs?code=abc123&state=xyz789')).toBe(
      'https://[HOMESERVER]/login/hs?code=[REDACTED]&state=[REDACTED]'
    );
    expect(scrubMatrixUrl('/login/hs?loginToken=syt_secret')).toBe(
      '/login/hs?loginToken=[REDACTED]'
    );
  });

  it('passes safe inputs through', () => {
    expect(scrubMatrixUrl('/home')).toBe('/home');
    expect(scrubMatrixUrl('')).toBe('');
  });
});

describe('omitIdentifierFields', () => {
  it('removes identifier keys and keeps the rest', () => {
    expect(
      omitIdentifierFields({ roomId: '!room:example.org', eventId: '$abc', kind: 'reaction' })
    ).toEqual({ kind: 'reaction' });
  });

  it('removes the snake_case keys the core emits', () => {
    expect(
      omitIdentifierFields({
        room_id: '!room:example.org',
        event_id: '$abc',
        sender_id: '@alice:example.org',
        kind: 'reaction',
      })
    ).toEqual({ kind: 'reaction' });
  });

  it('removes opaque ids that no value pattern would catch', () => {
    expect(
      omitIdentifierFields({ device_id: 'QBUAZIFURK', transaction_id: 'm1234567890' })
    ).toEqual({});
  });
});

describe('sanitizePayload', () => {
  it('drops identifier keys and redacts what remains', () => {
    expect(
      sanitizePayload({ roomId: '!room:example.org', message: 'from @alice:example.org' })
    ).toEqual({ message: 'from @[USER_ID]' });
  });

  it('drops a core payload down to its non-identifying fields', () => {
    expect(
      sanitizePayload({ room_id: '!room:example.org', device_id: 'QBUAZIFURK', code: 'failed' })
    ).toEqual({ code: 'failed' });
  });
});
