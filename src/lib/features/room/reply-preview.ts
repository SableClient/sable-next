import type { TimelineItemContentView } from '#src/generated/TimelineItemContentView';

export function replyPreviewBody(content: TimelineItemContentView): string {
  switch (content.kind) {
    case 'message':
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
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
