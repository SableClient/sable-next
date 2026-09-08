import { expect, test } from 'vitest';

import { resolveUserStatus } from './user-status.js';

test('prefers the profile status and keeps its emoji', () => {
  expect(
    resolveUserStatus(
      { status: { text: 'Shipping', emoji: '🚀' } },
      { statusMessage: 'In a meeting' }
    )
  ).toEqual({ text: 'Shipping', emoji: '🚀' });
});

test('falls back to the presence status message', () => {
  expect(resolveUserStatus({ status: null }, { statusMessage: 'In a meeting' })).toEqual({
    text: 'In a meeting',
    emoji: null,
  });
});

test('treats blank text as absent', () => {
  expect(
    resolveUserStatus({ status: { text: '   ', emoji: '🚀' } }, { statusMessage: '  ' })
  ).toBeNull();
  expect(resolveUserStatus(null, null)).toBeNull();
});

test('trims the text it keeps', () => {
  expect(resolveUserStatus({ status: { text: '  Shipping  ', emoji: null } }, null)).toEqual({
    text: 'Shipping',
    emoji: null,
  });
});
