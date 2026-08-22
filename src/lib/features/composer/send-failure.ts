import type { CommandErr } from '#src/generated/CommandErr';

function detailOf(cause: unknown): CommandErr | null {
  if (!(cause instanceof Error) || !('detail' in cause)) return null;
  const detail = (cause as { detail: unknown }).detail;
  if (typeof detail !== 'object' || detail === null || !('code' in detail)) return null;
  return detail as CommandErr;
}

export function sendFailureKey(cause: unknown): string {
  switch (detailOf(cause)?.code) {
    case 'denied':
      return 'composer.sendDenied';
    case 'rate_limited':
      return 'composer.sendRateLimited';
    case 'invalid_media':
      return 'composer.sendInvalidMedia';
    default:
      return 'timeline.sendFailed';
  }
}
