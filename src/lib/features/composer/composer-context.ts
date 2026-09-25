export interface ScheduledTarget {
  source: 'server' | 'queue';
  dueTs: number | null;
}

export interface ComposerContext {
  kind: 'reply' | 'edit' | 'schedule';
  eventId: string;
  timelineItemId?: string;
  sender?: string | null;
  silentReply?: boolean;
  body: string;
  html?: string | null;
  mediaCaption?: boolean;
  scheduled?: ScheduledTarget;
}

export function formattedForEditing(html: string | null | undefined): string | null {
  if (!html) return null;
  return html.trimStart().startsWith('<span data-plain-body') ? null : html;
}
