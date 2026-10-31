import { CoreError } from '#src/transport';
import { t } from '#lib/i18n.js';

export function bannedMessage(reason: string | null): string {
  return reason === null ? t('join.banned') : t('join.bannedReason', { reason });
}

export function isBanned(cause: unknown): boolean {
  return cause instanceof CoreError && cause.detail.code === 'banned';
}

export function joinErrorMessage(cause: unknown): string {
  if (cause instanceof CoreError) {
    switch (cause.detail.code) {
      case 'denied':
        return t('room.joinDenied');
      case 'banned':
        return bannedMessage(cause.detail.reason);
      case 'unknown_room':
        return t('room.joinUnknownRoom');
      case 'rate_limited':
        return t('room.joinRateLimited');
      case 'unavailable':
        return t('common.homeserverUnavailable');
      default:
        break;
    }
  }
  return t('common.roomJoinFailed');
}
