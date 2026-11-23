import { expect, onTestFinished, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import { parseJoinAddress } from './join-address';

test('the wasm binding round-trips a join address as JSON', () => {
  expect(parseJoinAddress('https://matrix.to/#/!abc:example.org?via=one.org')).toEqual({
    address: '!abc:example.org',
    via: ['one.org'],
  });
  expect(parseJoinAddress('')).toBeNull();
});

test('a link on the custom link host is a join address too', () => {
  preferences.matrixLinkSelector = 'custom';
  preferences.matrixLinkCustom = 'links.example.org';
  onTestFinished(() => {
    preferences.matrixLinkSelector = 'sable';
    preferences.matrixLinkCustom = '';
  });

  expect(parseJoinAddress(' https://links.example.org/#/!abc:example.org?via=one.org ')).toEqual({
    address: '!abc:example.org',
    via: ['one.org'],
  });
});
