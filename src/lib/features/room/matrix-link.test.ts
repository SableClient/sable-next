import { expect, test } from 'vitest';

import { parseMatrixLink } from './matrix-link';

test.each([
  ['matrix:u/alice:example.org', { kind: 'user', userId: '@alice:example.org' }],
  [
    'matrix:roomid/room:example.org/e/event',
    { kind: 'event', roomId: '!room:example.org', eventId: '$event' },
  ],
  ['https://matrix.to/#/#lobby:example.org', { kind: 'room', roomId: '#lobby:example.org' }],
  [
    'https://matrix.to/#/!room:example.org/$event',
    { kind: 'event', roomId: '!room:example.org', eventId: '$event' },
  ],
])('parses %s', (href, expected) => {
  expect(parseMatrixLink(href)).toEqual(expected);
});

test('does not treat arbitrary URLs as Matrix links', () => {
  expect(parseMatrixLink('https://example.org/#/!room:example.org')).toBeNull();
});

test.each([
  'matrix:u/alice:example.org/e/event',
  'matrix:roomid/room:example.org/e/event/extra',
  'matrix:roomid/room:example.org/x/event',
  'matrix:person/alice:example.org',
  'https://matrix.to/#/',
  'https://matrix.to/#/alice:example.org',
])('rejects %s', (href) => {
  expect(parseMatrixLink(href)).toBeNull();
});
