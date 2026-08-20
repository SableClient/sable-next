import { CoreError } from '#src/transport';
import { t } from '#lib/i18n.js';

interface VerificationErrorOptions {
  invalidRecoveryKey?: boolean;
}

export function verificationErrorMessage(
  cause: unknown,
  { invalidRecoveryKey = false }: VerificationErrorOptions = {}
): string {
  if (cause instanceof CoreError) {
    if (invalidRecoveryKey && cause.detail.code === 'denied') {
      return t('settings.invalidRecoveryKey');
    }
    if (cause.detail.code === 'unavailable') return t('settings.verificationUnavailable');
  }
  return t('settings.actionFailed');
}
