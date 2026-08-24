import { expect, test } from 'vitest';

import { callFailureKey, callStatusKey } from './call-status';

test('a reconnecting transport outranks an active lifecycle', () => {
  expect(callStatusKey({ lifecycle: 'active', connection: 'reconnecting', mediaReady: true })).toBe(
    'call.reconnecting'
  );
});

test('an encrypted call still waiting for its key reads as securing', () => {
  expect(
    callStatusKey({ lifecycle: 'connecting', connection: 'connecting', mediaReady: false })
  ).toBe('call.securing');
});

test('a connecting call with its key reads as connecting', () => {
  expect(
    callStatusKey({ lifecycle: 'connecting', connection: 'connecting', mediaReady: true })
  ).toBe('call.connecting');
});

test('every failure has its own message', () => {
  const keys = (
    ['busy', 'no-focus', 'e2ee-unsupported', 'e2ee-failed', 'setup-failed'] as const
  ).map(callFailureKey);

  expect(new Set(keys).size).toBe(keys.length);
});
