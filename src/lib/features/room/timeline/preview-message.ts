import type { TimelineItemView } from '#src/generated/protocol';

export function previewMessage(
  id: string,
  body: string,
  fields: Partial<TimelineItemView> = {}
): TimelineItemView {
  return {
    id,
    row: 'message',
    forwardable: true,
    redactable: true,
    visibility: 'always',
    event_id: null,
    transaction_id: null,
    send_state: null,
    sender: null,
    sender_name: null,
    sender_avatar: null,
    timestamp: 0,
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
    ...fields,
  };
}
