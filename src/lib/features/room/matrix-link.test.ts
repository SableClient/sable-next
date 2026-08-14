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
