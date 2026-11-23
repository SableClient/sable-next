import { expect, onTestFinished, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import { parseMatrixLink } from './matrix-link';

test.each(['link.sable.moe', 'matrix.to'])('the wasm binding parses links on %s', (host) => {
  expect(parseMatrixLink(`https://${host}/#/!room:example.org/$event`)).toEqual({
    kind: 'event',
    room_id: '!room:example.org',
    event_id: '$event',
  });
  expect(parseMatrixLink('https://example.org/#/!room:example.org')).toBeNull();
});

test('a link on the custom host the user writes links with parses too', () => {
  preferences.matrixLinkSelector = 'custom';
  preferences.matrixLinkCustom = 'links.example.org';
  onTestFinished(() => {
    preferences.matrixLinkSelector = 'sable';
    preferences.matrixLinkCustom = '';
  });

  expect(parseMatrixLink('https://links.example.org/#/@alice:example.org')).toEqual({
    kind: 'user',
    user_id: '@alice:example.org',
  });
});
