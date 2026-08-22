import { expect, test } from 'vitest';

import { sendFailureKey } from './send-failure';

class CoreErrorLike extends Error {
  constructor(readonly detail: { code: string }) {
    super(detail.code);
  }
}

test.each([
  ['denied', 'composer.sendDenied'],
  ['rate_limited', 'composer.sendRateLimited'],
  ['invalid_media', 'composer.sendInvalidMedia'],
  ['unavailable', 'timeline.sendFailed'],
])('a %s failure reads as %s', (code, key) => {
  expect(sendFailureKey(new CoreErrorLike({ code }))).toBe(key);
});

test.each([
  ['a plain error', new Error('offline')],
  ['a thrown string', 'offline'],
  ['nothing', undefined],
])('%s falls back to the generic failure', (_name, cause) => {
  expect(sendFailureKey(cause)).toBe('timeline.sendFailed');
});
