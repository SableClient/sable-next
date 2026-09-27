import { expect, test } from 'vitest';

import { LocalNetworkBlockedError } from '#lib/platform/local-network.js';
import { CoreError } from '#src/transport';

import { authenticationError } from './registration-errors';

test('a sign-in blocked by the browser names the homeserver to exempt', () => {
  const message = authenticationError(new LocalNetworkBlockedError('matrix.lan'));

  expect(message).toContain('matrix.lan');
  expect(message).not.toBe(authenticationError(new CoreError({ code: 'unavailable' })));
});
