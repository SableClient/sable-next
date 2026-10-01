import { expect, test } from 'vitest';

import { LocalNetworkBlockedError } from '#lib/platform/local-network.js';
import { CoreError } from '#src/transport';

import { authenticationError } from './registration-errors';

test('explains unsupported Sliding Sync separately from a network failure', () => {
  expect(authenticationError(new CoreError({ code: 'sliding_sync_unsupported' }))).toBe(
    'This homeserver does not support Sliding Sync.'
  );
  expect(authenticationError(new CoreError({ code: 'unavailable' }))).not.toBe(
    authenticationError(new CoreError({ code: 'sliding_sync_unsupported' }))
  );
});

test('a sign-in blocked by the browser names the homeserver to exempt', () => {
  const message = authenticationError(new LocalNetworkBlockedError('matrix.lan'));

  expect(message).toContain('matrix.lan');
  expect(message).not.toBe(authenticationError(new CoreError({ code: 'unavailable' })));
});
