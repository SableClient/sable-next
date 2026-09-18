import type { TimelineItemContentView } from '#src/generated/protocol';

export function replyPreviewBody(content: TimelineItemContentView): string {
  switch (content.kind) {
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return content.caption ?? content.filename;
    case 'message':
    case 'sticker':
    case 'location':
    case 'gallery':
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
