import { expect, test } from 'vitest';

import { sendFailure } from './send-failure';
import { SlashError } from './slash-commands';

class CoreErrorLike extends Error {
  constructor(readonly detail: { code: string }) {
    super(detail.code);
  }
}

test.each([
  ['denied', 'composer.sendDenied', false],
  ['rate_limited', 'composer.sendRateLimited', true],
  ['invalid_media', 'composer.sendInvalidMedia', false],
  ['unavailable', 'composer.sendUnavailable', true],
  ['media_server_unavailable', 'composer.sendMediaServerUnavailable', true],
  ['account_locked', 'composer.sendAccountLocked', false],
  ['account_suspended', 'composer.sendAccountSuspended', false],
  ['failed', 'composer.sendFailed', true],
])('a %s failure reads as %s', (code, key, retryable) => {
  expect(sendFailure(new CoreErrorLike({ code }))).toEqual({ key, retryable });
});

test.each([
  ['a plain error', new Error('offline')],
  ['a thrown string', 'offline'],
  ['nothing', undefined],
])('%s falls back to the generic failure', (_name, cause) => {
  expect(sendFailure(cause)).toEqual({ key: 'composer.sendFailed', retryable: true });
});

test('a slash command failure keeps its own wording', () => {
  const failure = sendFailure(new SlashError('composer.slashUnknown', { name: 'nope' }));

  expect(failure).toEqual({
    key: 'composer.slashUnknown',
    values: { name: 'nope' },
    retryable: false,
  });
});
