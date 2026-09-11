export interface ComposerContext {
  kind: 'reply' | 'edit';
  eventId: string;
  timelineItemId?: string;
  sender?: string | null;
  silentReply?: boolean;
  body: string;
  html?: string | null;
  mediaCaption?: boolean;
}

export function formattedForEditing(html: string | null | undefined): string | null {
  if (!html) return null;
  return html.trimStart().startsWith('<span data-plain-body') ? null : html;
}
