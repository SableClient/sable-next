import { expect, test } from 'vitest';

import { backupFileName } from './backup';

test('a backup file is named after its date', () => {
  expect(backupFileName(new Date('2026-09-23T12:00:00Z'))).toBe('sable-profiles-2026-09-23.json');
});
