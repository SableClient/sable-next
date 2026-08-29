import type { UtdCauseView } from '#src/generated/UtdCauseView';

const KEYS: Record<UtdCauseView, string> = {
  unknown: 'timeline.utdUnknown',
  sent_before_we_joined: 'timeline.utdSentBeforeWeJoined',
  verification_violation: 'timeline.utdVerificationViolation',
  unsigned_device: 'timeline.utdUnsignedDevice',
  unknown_device: 'timeline.utdUnknownDevice',
  historical_message_backup_disabled: 'timeline.utdBackupDisabled',
  historical_message_device_unverified: 'timeline.utdDeviceUnverified',
  withheld_for_unverified_or_insecure_device: 'timeline.utdWithheldUnverified',
  withheld_by_sender: 'timeline.utdWithheldBySender',
};

export function utdCauseKey(cause: UtdCauseView): string {
  return KEYS[cause];
}

const RECOVERABLE = new Set<UtdCauseView>([
  'unknown',
  'historical_message_backup_disabled',
  'historical_message_device_unverified',
]);

export function utdIsRecoverable(cause: UtdCauseView): boolean {
  return RECOVERABLE.has(cause);
}
