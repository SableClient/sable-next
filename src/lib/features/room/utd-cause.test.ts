import { expect, test } from 'vitest';

import type { UtdCauseView } from '#src/generated/UtdCauseView';

import { utdCauseKey, utdIsRecoverable } from './utd-cause.js';

const ALL: UtdCauseView[] = [
  'unknown',
  'sent_before_we_joined',
  'verification_violation',
  'unsigned_device',
  'unknown_device',
  'historical_message_backup_disabled',
  'historical_message_device_unverified',
  'withheld_for_unverified_or_insecure_device',
  'withheld_by_sender',
];

test('every cause has its own message', () => {
  const keys = ALL.map(utdCauseKey);

  expect(keys.every((key) => key.startsWith('timeline.utd'))).toBe(true);
  expect(new Set(keys).size).toBe(ALL.length);
});

test('only the causes a key backup can still answer offer recovery', () => {
  expect(ALL.filter(utdIsRecoverable)).toEqual([
    'unknown',
    'historical_message_backup_disabled',
    'historical_message_device_unverified',
  ]);
});

test('a cause the sender chose is never presented as recoverable', () => {
  expect(utdIsRecoverable('withheld_by_sender')).toBe(false);
  expect(utdIsRecoverable('sent_before_we_joined')).toBe(false);
});
