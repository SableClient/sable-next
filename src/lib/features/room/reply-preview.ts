import type { TimelineItemContentView } from '#src/generated/protocol';

const SPOILER = 'data-mx-spoiler';

function spoilerSafe(body: string, html: string | null): string {
  if (html === null || !html.includes(SPOILER)) return body;
  const parsed = new DOMParser().parseFromString(html, 'text/html').body;
  for (const spoiler of parsed.querySelectorAll(`[${SPOILER}]`)) spoiler.replaceWith('[Spoiler]');
  for (const lineBreak of parsed.querySelectorAll('br')) lineBreak.replaceWith('\n');
  return parsed.textContent;
}

export function replyPreviewBody(content: TimelineItemContentView): string {
  switch (content.kind) {
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return content.caption === null
        ? content.filename
        : spoilerSafe(content.caption, content.html);
    case 'message':
    case 'gallery':
      return spoilerSafe(content.body, content.html);
    case 'sticker':
    case 'location':
      return content.body;
    case 'poll':
      return content.poll.question;
    case 'state_event':
      return content.event_type;
    case 'hidden_event':
      return content.event_type;
    default:
      return '';
  }
}
