import type { TimelineItemView } from '#src/generated/protocol';

export const PREVIEW_LENGTH = 140;

type Translate = (key: string, options?: Record<string, unknown>) => string;

function preview(item: TimelineItemView): string | null {
  if (item.content.kind !== 'message') return null;
  const text = item.content.body.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text;
}

export function arrivalAnnouncement(
  arrivals: readonly TimelineItemView[],
  atLiveEdge: boolean,
  t: Translate
): string {
  const latest = arrivals.at(-1);
  const sender = latest?.per_message_profile?.display_name ?? latest?.sender_name ?? latest?.sender;
  const text = arrivals.length === 1 && atLiveEdge && latest ? preview(latest) : null;
  if (text && sender) return t('timeline.newMessagePreview', { sender, preview: text });
  return t('timeline.newMessages', { count: arrivals.length });
}
