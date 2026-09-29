import { expect, test } from 'vitest';

import { PushConfigMissing, readPushFailure } from './push-failure';

test('a shell failure keeps its stage', () => {
  expect(readPushFailure({ stage: 'no_app_id' })).toEqual({ stage: 'no_app_id' });
  expect(readPushFailure({ stage: 'platform', message: 'denied by user' })).toEqual({
    stage: 'platform',
    message: 'denied by user',
  });
  expect(readPushFailure({ stage: 'homeserver', error: { code: 'failed', log_id: 'x' } })).toEqual({
    stage: 'homeserver',
    code: 'failed',
  });
});

test('a core error is the homeserver refusing', () => {
  expect(readPushFailure({ code: 'unavailable' })).toEqual({
    stage: 'homeserver',
    code: 'unavailable',
  });
});

test('a browser error keeps its message', () => {
  expect(readPushFailure(new DOMException('push service error', 'AbortError'))).toEqual({
    stage: 'platform',
    message: 'push service error',
  });
});

test('a missing gateway configuration is its own stage', () => {
  expect(readPushFailure(new PushConfigMissing())).toEqual({ stage: 'config' });
});
