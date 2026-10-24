import type { ResolvedItem } from '#lib/rooms/timeline-item.js';

export function previewMessage(
  id: string,
  body: string,
  fields: Partial<ResolvedItem> = {}
): ResolvedItem {
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
      emote: false,
      notice: false,
      edited: false,
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
    ...fields,
  };
}
