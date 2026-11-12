import { CoreError, isCoreError } from '#src/transport';
import { t } from '#lib/i18n.js';
import { LocalNetworkBlockedError } from '#lib/platform/local-network.js';

const EXPECTED_AUTH_FAILURES = new Set([
  'denied',
  'rate_limited',
  'unavailable',
  'account_locked',
  'account_suspended',
  'unknown_homeserver',
  'auth_provider_unreachable',
]);

export function logAuthenticationFailure(operation: string, value: unknown): void {
  const error = value instanceof CoreError ? value.detail : { code: 'unexpected' };
  const log = EXPECTED_AUTH_FAILURES.has(error.code) ? console.warn : console.error;
  log(`[sable:auth] authentication failed: ${operation} ${error.code}`, { operation, error });
}

export function registrationError(value: unknown): string {
  if (!(value instanceof CoreError)) return t('errors.connectionError');

  switch (value.detail.code) {
    case 'registration_unavailable':
      return t('errors.registrationUnavailable');
    case 'username_taken':
      return t('errors.usernameTaken');
    case 'invalid_username':
      return t('errors.invalidUsername');
    case 'invalid_email':
      return t('errors.invalidEmail');
    case 'email_verification_failed':
      return t('errors.emailVerificationFailed');
    case 'weak_password':
      return t('errors.weakPassword');
    case 'registration_stage_failed':
      if (value.detail.stage.includes('registration_token'))
        return t('errors.registrationTokenRejected');
      if (value.detail.stage.includes('password')) return t('errors.weakPassword');
      if (value.detail.stage.includes('email')) return t('errors.emailVerificationFailed');
      return t('errors.registrationStageFailed');
    case 'rate_limited':
      return value.detail.retry_after_ms
        ? t('errors.tooManyAttemptsSeconds', {
            seconds: Math.ceil(value.detail.retry_after_ms / 1000),
          })
        : t('errors.tooManyAttempts');
    case 'unknown_homeserver':
      return t('errors.homeserverNotFound');
    case 'auth_provider_unreachable':
      return t('errors.authProviderUnreachable');
    case 'sliding_sync_unsupported':
      return t('errors.slidingSyncUnsupported');
    default:
      return t('errors.registrationFailed');
  }
}

export function registrationHomeserverError(value: unknown): string {
  if (isCoreError(value, 'sliding_sync_unsupported')) {
    return authenticationError(value);
  }
  if (isCoreError(value, 'unsupported')) {
    return t('errors.registrationUnavailable');
  }
  return t('errors.homeserverNotFound');
}

export function authenticationError(value: unknown): string {
  if (value instanceof LocalNetworkBlockedError) {
    return t('errors.localNetworkBlocked', { host: value.host });
  }
  if (!(value instanceof CoreError)) return t('errors.connectionError');

  switch (value.detail.code) {
    case 'denied':
      return t('errors.invalidCredentials');
    case 'account_locked':
      return t('errors.accountLocked');
    case 'account_suspended':
      return t('errors.accountSuspended');
    case 'rate_limited':
      return value.detail.retry_after_ms
        ? t('errors.tooManyAttemptsSeconds', {
            seconds: Math.ceil(value.detail.retry_after_ms / 1000),
          })
        : t('errors.tooManyAttempts');
    case 'unavailable':
      return t('common.homeserverUnavailable');
    case 'unknown_homeserver':
      return t('errors.homeserverNotFound');
    case 'unsupported':
      return t('errors.passwordUnsupported');
    case 'sliding_sync_unsupported':
      return t('errors.slidingSyncUnsupported');
    case 'auth_provider_unreachable':
      return t('errors.authProviderUnreachable');
    default:
      return t('errors.coreError');
  }
}
