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

/* The spec's own matrix.to examples, which all carry `via` because a room id is
   not routable without one. matrix.to puts it inside the fragment. */
test.each([
  [
    'https://matrix.to/#/!somewhere:example.org?via=elsewhere.ca',
    { kind: 'room', roomId: '!somewhere:example.org' },
  ],
  [
    'https://matrix.to/#/!somewhere:example.org/$event:example.org?via=elsewhere.ca',
    { kind: 'event', roomId: '!somewhere:example.org', eventId: '$event:example.org' },
  ],
  [
    'matrix:roomid/somewhere:example.org/e/event?via=elsewhere.ca',
    { kind: 'event', roomId: '!somewhere:example.org', eventId: '$event' },
  ],
])('keeps via out of the ids in %s', (href, expected) => {
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
