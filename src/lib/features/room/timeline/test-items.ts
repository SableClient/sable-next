import type { TimelineItemView } from '#src/generated/protocol';

import { withRowFields } from './row-fixtures.js';

export function timelineItem(
  id: string,
  body = id,
  options: { eventId?: string; sender?: string; timestamp?: number } = {}
): TimelineItemView {
  return withRowFields({
    id,
    event_id: options.eventId ?? `$${id}`,
    transaction_id: null,
    send_state: null,
    sender: options.sender ?? '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: options.timestamp ?? 0,
    content: {
      kind: 'message',
      body,
      html: body,
      msgtype: 'text',
      edited: false,
      jumbo: null,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
    shield: null,
  });
}
