import { CoreError } from '#src/transport';
import { t } from '#lib/i18n.js';

export function joinErrorMessage(cause: unknown): string {
  if (cause instanceof CoreError) {
    switch (cause.detail.code) {
      case 'denied':
        return t('room.joinDenied');
      case 'unknown_room':
        return t('room.joinUnknownRoom');
      case 'rate_limited':
        return t('room.joinRateLimited');
      case 'unavailable':
        return t('room.joinUnavailable');
      default:
        break;
    }
  }
  return t('room.joinFailed');
}
