import { expect, test } from 'vitest';

import { notificationPermalink } from './notification-link';

test('a notification link names the account the alert was for', () => {
  const link = new URL(
    notificationPermalink('!room:example.org', '$event', '@bob:example.org'),
    'https://app.example'
  );

  expect(decodeURIComponent(link.pathname)).toBe('/to/!room:example.org');
  expect(link.searchParams.get('notified')).toBe('$event');
  expect(link.searchParams.get('user')).toBe('@bob:example.org');
});

test('a notification link without an event or account opens the room alone', () => {
  expect(notificationPermalink('!room:example.org', null, undefined)).toBe(
    '/to/!room%3Aexample.org'
  );
});
