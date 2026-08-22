export interface ComposerContext {
  kind: 'reply' | 'edit';
  eventId: string;
  sender?: string | null;
  body: string;
  /** The timeline's display HTML, which an edit prefills from when the sender
      formatted the message. */
  html?: string | null;
}

/**
 * The core wraps an unformatted body in `<span data-plain-body>` after
 * linkifying it, and those anchors would come back as link marks and be sent
 * as HTML. Such a message is prefilled from its plain body instead.
 */
export function formattedForEditing(html: string | null | undefined): string | null {
  if (!html) return null;
  return html.trimStart().startsWith('<span data-plain-body') ? null : html;
}
