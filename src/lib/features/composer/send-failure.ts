import type { CommandErr } from '#src/generated/protocol';

import { SlashError } from './slash-commands';

export type SendFailure = { key: string; values?: Record<string, string>; retryable: boolean };

export class ScheduledOriginalKept extends Error {
  constructor(cause: unknown) {
    super('the replaced scheduled message could not be cancelled', { cause });
  }
}

function detailOf(cause: unknown): CommandErr | null {
  if (!(cause instanceof Error) || !('detail' in cause)) return null;
  const detail = (cause as { detail: unknown }).detail;
  if (typeof detail !== 'object' || detail === null || !('code' in detail)) return null;
  return detail as CommandErr;
}

export function isServerScheduleUnsupported(cause: unknown): boolean {
  const code = detailOf(cause)?.code;
  return code === 'encrypted_schedule_unsupported' || code === 'delayed_events_unsupported';
}

export function isEncryptedScheduleUnsupported(cause: unknown): boolean {
  return detailOf(cause)?.code === 'encrypted_schedule_unsupported';
}

export function sendFailure(cause: unknown): SendFailure {
  if (cause instanceof SlashError)
    return { key: cause.key, values: cause.values, retryable: false };

  switch (detailOf(cause)?.code) {
    case 'denied':
      return { key: 'composer.sendDenied', retryable: false };
    case 'rate_limited':
      return { key: 'composer.sendRateLimited', retryable: true };
    case 'invalid_media':
      return { key: 'composer.sendInvalidMedia', retryable: false };
    case 'unavailable':
      return { key: 'composer.sendUnavailable', retryable: true };
    case 'media_server_unavailable':
      return { key: 'composer.sendMediaServerUnavailable', retryable: true };
    case 'account_locked':
      return { key: 'composer.sendAccountLocked', retryable: false };
    case 'account_suspended':
      return { key: 'composer.sendAccountSuspended', retryable: false };
    default:
      return { key: 'composer.sendFailed', retryable: true };
  }
}
