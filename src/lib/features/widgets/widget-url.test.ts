import { expect, test } from 'vitest';

import type { RoomWidget } from './widget-content.js';
import { templateWidgetUrl, WIDGET_CLIENT_ID } from './widget-url.js';

const vars = {
  userId: '@erwan:example.org',
  roomId: '!abc:example.org',
  displayName: 'Erwan',
  avatarUrl: 'mxc://example.org/avatar',
};

function widget(url: string, data: Record<string, unknown> = {}): RoomWidget {
  return { id: 'widget-1', type: 'grafana', url, name: 'Dashboard', data };
}

test('substitutes every template variable', () => {
  const url = templateWidgetUrl(
    widget(
      'https://widget.example/app?user=$matrix_user_id&room=$matrix_room_id&name=$matrix_display_name&avatar=$matrix_avatar_url&wid=$matrix_widget_id'
    ),
    vars
  );
  const parsed = new URL(url);
  expect(parsed.searchParams.get('user')).toBe(vars.userId);
  expect(parsed.searchParams.get('room')).toBe(vars.roomId);
  expect(parsed.searchParams.get('name')).toBe(vars.displayName);
  expect(parsed.searchParams.get('avatar')).toBe(vars.avatarUrl);
  expect(parsed.searchParams.get('wid')).toBe('widget-1');
});

test('substitutes the custom keys a widget carries in its own data', () => {
  const url = templateWidgetUrl(
    widget('https://widget.example/app?conf=$conferenceId&domain=$domain', {
      conferenceId: 'standup',
      domain: 'meet.example.org',
    }),
    vars
  );
  const parsed = new URL(url);
  expect(parsed.searchParams.get('conf')).toBe('standup');
  expect(parsed.searchParams.get('domain')).toBe('meet.example.org');
});

test('a widget cannot override a supplied variable through its own data', () => {
  const url = templateWidgetUrl(
    widget('https://widget.example/app?user=$matrix_user_id', {
      matrix_user_id: '@attacker:example.org',
    }),
    vars
  );
  expect(new URL(url).searchParams.get('user')).toBe(vars.userId);
});

test('substitutes the client identity variables', () => {
  const url = templateWidgetUrl(
    widget(
      'https://widget.example/app?client=$org.matrix.msc2873.client_id&device=$org.matrix.msc3819.matrix_device_id&base=$org.matrix.msc4039.matrix_base_url'
    ),
    { ...vars, deviceId: 'DEVICE1', baseUrl: 'https://matrix.example.org' }
  );
  const parsed = new URL(url);
  expect(parsed.searchParams.get('client')).toBe(WIDGET_CLIENT_ID);
  expect(parsed.searchParams.get('device')).toBe('DEVICE1');
  expect(parsed.searchParams.get('base')).toBe('https://matrix.example.org');
});

test('falls back to the user id when there is no display name', () => {
  const url = templateWidgetUrl(widget('https://widget.example/app?name=$matrix_display_name'), {
    ...vars,
    displayName: '',
  });
  expect(new URL(url).searchParams.get('name')).toBe(vars.userId);
});

test('adds a widgetId query parameter when absent', () => {
  const url = templateWidgetUrl(widget('https://widget.example/app'), vars);
  expect(new URL(url).searchParams.get('widgetId')).toBe('widget-1');
});

test('leaves an existing widgetId query parameter alone', () => {
  const url = templateWidgetUrl(widget('https://widget.example/app?widgetId=already-set'), vars);
  expect(new URL(url).searchParams.get('widgetId')).toBe('already-set');
});

test('percent-encodes a value that would otherwise inject a query parameter', () => {
  const url = templateWidgetUrl(widget('https://widget.example/app?name=$matrix_display_name'), {
    ...vars,
    displayName: 'Erwan&admin=true',
  });
  const parsed = new URL(url);
  expect(parsed.searchParams.get('name')).toBe('Erwan&admin=true');
  expect(parsed.searchParams.has('admin')).toBe(false);
});

test('percent-encodes a value that would otherwise break out of the query string', () => {
  const url = templateWidgetUrl(widget('https://widget.example/app?name=$matrix_display_name'), {
    ...vars,
    displayName: '#evil=1',
  });
  const parsed = new URL(url);
  expect(parsed.searchParams.get('name')).toBe('#evil=1');
  expect(parsed.hash).toBe('');
});

test('returns the templated string unchanged if the result is not a valid url', () => {
  const url = templateWidgetUrl(widget('not a url $matrix_user_id'), vars);
  expect(url).toBe(`not a url ${encodeURIComponent(vars.userId)}`);
});
