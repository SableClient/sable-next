import { expect, test } from 'vitest';

import { sendFailure } from './send-failure';
import { SlashError } from './slash-commands';

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
  expect(sendFailure(new CoreErrorLike({ code }))).toEqual({ key });
});

test.each([
  ['a plain error', new Error('offline')],
  ['a thrown string', 'offline'],
  ['nothing', undefined],
])('%s falls back to the generic failure', (_name, cause) => {
  expect(sendFailure(cause)).toEqual({ key: 'timeline.sendFailed' });
});

test('a slash command failure keeps its own wording', () => {
  const failure = sendFailure(new SlashError('composer.slashUnknown', { name: 'nope' }));

  expect(failure).toEqual({ key: 'composer.slashUnknown', values: { name: 'nope' } });
});
