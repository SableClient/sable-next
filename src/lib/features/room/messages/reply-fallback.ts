import type { ReplyFallbackView, ReplyView } from '#src/generated/protocol';

import type { Translate } from '../timeline/state-event-text';

export function fallbackText(
  body: string | null,
  fallback: ReplyFallbackView | null,
  t: Translate
): string {
  if (body !== null) return body;
  switch (fallback?.kind) {
    case 'redacted':
      return t('timeline.redacted');
    case 'reaction':
      return t('timeline.replyToReaction', { key: fallback.key });
    case 'redaction':
      return t('timeline.replyToRedaction');
    case 'event':
      return t('timeline.replyToEvent', { type: fallback.event_type });
    case undefined:
      return '';
  }
}

export function replyText(reply: ReplyView | null, t: Translate): string {
  return reply === null ? '' : fallbackText(reply.body, reply.fallback, t);
}
