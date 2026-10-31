import { expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { CoreError } from '#src/transport';
import { joinErrorMessage } from './join-errors.js';

test('a ban names its reason when the moderator gave one', () => {
  expect(joinErrorMessage(new CoreError({ code: 'banned', reason: 'spam' }))).toBe(
    'join.bannedReason:spam'
  );
  expect(joinErrorMessage(new CoreError({ code: 'banned', reason: null }))).toBe('join.banned');
});
