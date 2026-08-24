import { beforeEach, expect, test } from 'vitest';

import { acquireCallOwner, activeCallOwner, resetCallOwner } from './call-owner';

beforeEach(() => {
  resetCallOwner();
});

test('a second call cannot start while one is running', () => {
  const first = acquireCallOwner('livekit-js', '!a:example.org');

  expect(first).toBeDefined();
  expect(acquireCallOwner('livekit-js', '!b:example.org')).toBeUndefined();
});

test('releasing a lease lets the next call start', () => {
  acquireCallOwner('livekit-js', '!a:example.org')?.release();

  expect(activeCallOwner()).toBeUndefined();
  expect(acquireCallOwner('livekit-native', '!b:example.org')).toBeDefined();
});

test('a stale lease cannot release the call that replaced it', () => {
  const stale = acquireCallOwner('livekit-js', '!a:example.org');
  stale?.release();
  const current = acquireCallOwner('livekit-js', '!b:example.org');

  stale?.release();

  expect(activeCallOwner()).toMatchObject({ kind: 'livekit-js', roomId: '!b:example.org' });
  expect(current).toBeDefined();
});
