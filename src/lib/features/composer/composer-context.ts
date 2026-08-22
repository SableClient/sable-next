export interface ComposerContext {
  kind: 'reply' | 'edit';
  eventId: string;
  sender?: string | null;
  body: string;
  html?: string | null;
}

export function formattedForEditing(html: string | null | undefined): string | null {
  if (!html) return null;
  return html.trimStart().startsWith('<span data-plain-body') ? null : html;
}
