import { isRecord } from '#lib/guards.js';
import type { ReplyFallback } from '#lib/rooms/timeline.svelte.js';

import { reactionKey, type Translate } from './state-event-text';

export function replyFallbackFromSource(source: string, t: Translate): ReplyFallback | null {
  let event: unknown;
  try {
    event = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(event) || typeof event.type !== 'string') return null;

  const sender = typeof event.sender === 'string' ? event.sender : null;
  const key = event.type === 'm.reaction' ? reactionKey(event.content) : null;
  if (key) return { sender, body: t('timeline.replyToReaction', { key }) };
  if (event.type === 'm.room.redaction') return { sender, body: t('timeline.replyToRedaction') };
  if (isRecord(event.content) && typeof event.content.body === 'string' && event.content.body) {
    return { sender, body: event.content.body };
  }
  return { sender, body: t('timeline.replyToEvent', { type: event.type }) };
}
