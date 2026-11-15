import { expect, test } from 'vitest';

import { parseMatrixLink } from './matrix-link';

test.each(['link.sable.moe', 'matrix.to'])('the wasm binding parses links on %s', (host) => {
  expect(parseMatrixLink(`https://${host}/#/!room:example.org/$event`)).toEqual({
    kind: 'event',
    room_id: '!room:example.org',
    event_id: '$event',
  });
  expect(parseMatrixLink('https://example.org/#/!room:example.org')).toBeNull();
});
