import { expect, test } from 'vitest';

import { templateWidgetUrl } from './widget-url.js';

const vars = {
  userId: '@erwan:example.org',
  roomId: '!abc:example.org',
  displayName: 'Erwan',
  avatarUrl: 'mxc://example.org/avatar',
  widgetId: 'widget-1',
};

test('substitutes every template variable', () => {
  const url = templateWidgetUrl(
    'https://widget.example/app?user=$matrix_user_id&room=$matrix_room_id&name=$matrix_display_name&avatar=$matrix_avatar_url&wid=$matrix_widget_id',
    vars
  );
  const parsed = new URL(url);
  expect(parsed.searchParams.get('user')).toBe(vars.userId);
  expect(parsed.searchParams.get('room')).toBe(vars.roomId);
  expect(parsed.searchParams.get('name')).toBe(vars.displayName);
  expect(parsed.searchParams.get('avatar')).toBe(vars.avatarUrl);
  expect(parsed.searchParams.get('wid')).toBe(vars.widgetId);
});

test('adds a widgetId query parameter when absent', () => {
  const url = templateWidgetUrl('https://widget.example/app', vars);
  expect(new URL(url).searchParams.get('widgetId')).toBe('widget-1');
});

test('leaves an existing widgetId query parameter alone', () => {
  const url = templateWidgetUrl('https://widget.example/app?widgetId=already-set', vars);
  expect(new URL(url).searchParams.get('widgetId')).toBe('already-set');
});

test('percent-encodes a value that would otherwise inject a query parameter', () => {
  const url = templateWidgetUrl('https://widget.example/app?name=$matrix_display_name', {
    ...vars,
    displayName: 'Erwan&admin=true',
  });
  const parsed = new URL(url);
  expect(parsed.searchParams.get('name')).toBe('Erwan&admin=true');
  expect(parsed.searchParams.has('admin')).toBe(false);
});

test('percent-encodes a value that would otherwise break out of the query string', () => {
  const url = templateWidgetUrl('https://widget.example/app?name=$matrix_display_name', {
    ...vars,
    displayName: '#evil=1',
  });
  const parsed = new URL(url);
  expect(parsed.searchParams.get('name')).toBe('#evil=1');
  expect(parsed.hash).toBe('');
});

test('returns the templated string unchanged if the result is not a valid url', () => {
  const url = templateWidgetUrl('not a url $matrix_user_id', vars);
  expect(url).toBe(`not a url ${encodeURIComponent(vars.userId)}`);
});
