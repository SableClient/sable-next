import { expect, test } from 'vitest';

import { parseJoinAddress } from './join-address';

test('a bare alias or room id needs no via servers', () => {
  expect(parseJoinAddress('#room:example.org')).toEqual({
    address: '#room:example.org',
    via: [],
  });
  expect(parseJoinAddress('  !abc:example.org  ')).toEqual({
    address: '!abc:example.org',
    via: [],
  });
});

test('a matrix.to link keeps its via servers out of the room id', () => {
  expect(parseJoinAddress('https://matrix.to/#/!abc:example.org?via=one.org&via=two.org')).toEqual({
    address: '!abc:example.org',
    via: ['one.org', 'two.org'],
  });
});

test('a matrix: URI resolves to the same address', () => {
  expect(parseJoinAddress('matrix:roomid/abc:example.org?via=one.org')).toEqual({
    address: '!abc:example.org',
    via: ['one.org'],
  });
});

test('an event permalink joins the room it names', () => {
  expect(parseJoinAddress('https://matrix.to/#/#room:example.org/$event')).toEqual({
    address: '#room:example.org',
    via: [],
  });
});

test('a user link is not a room to join', () => {
  expect(parseJoinAddress('https://matrix.to/#/@someone:example.org')).toBeNull();
});

test('anything unparseable is rejected', () => {
  expect(parseJoinAddress('')).toBeNull();
  expect(parseJoinAddress('room:example.org')).toBeNull();
  expect(parseJoinAddress('https://example.org/#/!abc:example.org')).toBeNull();
});
