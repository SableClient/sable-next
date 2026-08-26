import type { CommandErr } from '#src/generated/CommandErr';

import { SlashError } from './slash-commands';

export type SendFailure = { key: string; values?: Record<string, string> };

function detailOf(cause: unknown): CommandErr | null {
  if (!(cause instanceof Error) || !('detail' in cause)) return null;
  const detail = (cause as { detail: unknown }).detail;
  if (typeof detail !== 'object' || detail === null || !('code' in detail)) return null;
  return detail as CommandErr;
}

export function sendFailure(cause: unknown): SendFailure {
  if (cause instanceof SlashError) return { key: cause.key, values: cause.values };

  switch (detailOf(cause)?.code) {
    case 'denied':
      return { key: 'composer.sendDenied' };
    case 'rate_limited':
      return { key: 'composer.sendRateLimited' };
    case 'invalid_media':
      return { key: 'composer.sendInvalidMedia' };
    default:
      return { key: 'timeline.sendFailed' };
  }
}
