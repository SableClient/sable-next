import { expect, test } from 'vitest';

import { parseRoomWidget } from './widget-content.js';

test('parses a well-formed widget', () => {
  expect(
    parseRoomWidget('widget-1', {
      type: 'm.custom',
      url: 'https://example.org/widget',
      name: 'My Widget',
      data: { foo: 'bar' },
    })
  ).toEqual({
    id: 'widget-1',
    type: 'm.custom',
    url: 'https://example.org/widget',
    name: 'My Widget',
    data: { foo: 'bar' },
  });
});

test('defaults a missing name and data', () => {
  expect(
    parseRoomWidget('widget-1', { type: 'm.custom', url: 'https://example.org/widget' })
  ).toEqual({
    id: 'widget-1',
    type: 'm.custom',
    url: 'https://example.org/widget',
    name: 'Widget',
    data: {},
  });
});

test('rejects an empty state key', () => {
  expect(parseRoomWidget('', { type: 'm.custom', url: 'https://example.org/widget' })).toBeNull();
});

test('rejects a removed widget (empty content)', () => {
  expect(parseRoomWidget('widget-1', {})).toBeNull();
});

test('rejects content that is not an object', () => {
  expect(parseRoomWidget('widget-1', null)).toBeNull();
  expect(parseRoomWidget('widget-1', 'https://example.org/widget')).toBeNull();
  expect(parseRoomWidget('widget-1', 42)).toBeNull();
});

test('rejects a missing or blank type', () => {
  expect(parseRoomWidget('widget-1', { url: 'https://example.org/widget' })).toBeNull();
  expect(parseRoomWidget('widget-1', { type: '', url: 'https://example.org/widget' })).toBeNull();
  expect(parseRoomWidget('widget-1', { type: 1, url: 'https://example.org/widget' })).toBeNull();
});

test('rejects a missing, blank or malformed url', () => {
  expect(parseRoomWidget('widget-1', { type: 'm.custom' })).toBeNull();
  expect(parseRoomWidget('widget-1', { type: 'm.custom', url: '' })).toBeNull();
  expect(parseRoomWidget('widget-1', { type: 'm.custom', url: 'not a url' })).toBeNull();
});

test('rejects a non-http(s) url scheme', () => {
  expect(parseRoomWidget('widget-1', { type: 'm.custom', url: 'javascript:alert(1)' })).toBeNull();
  expect(
    parseRoomWidget('widget-1', { type: 'm.custom', url: 'data:text/html,<script></script>' })
  ).toBeNull();
});

test('ignores malformed data and non-string name', () => {
  expect(
    parseRoomWidget('widget-1', {
      type: 'm.custom',
      url: 'https://example.org/widget',
      name: 42,
      data: 'not an object',
    })
  ).toEqual({
    id: 'widget-1',
    type: 'm.custom',
    url: 'https://example.org/widget',
    name: 'Widget',
    data: {},
  });
});

test('ignores an array passed as data', () => {
  expect(
    parseRoomWidget('widget-1', {
      type: 'm.custom',
      url: 'https://example.org/widget',
      data: ['not', 'an', 'object'],
    })
  ).toEqual({
    id: 'widget-1',
    type: 'm.custom',
    url: 'https://example.org/widget',
    name: 'Widget',
    data: {},
  });
});
