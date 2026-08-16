// These shapes must track src/generated/TimelineItemContentView.ts; the app
// reads content.html, so a body-only override renders the previous text.

export function timelineItem(id: string, body: string) {
  return {
    id,
    event_id: `$${id}:example.test`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.test',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 1_700_000_000_000,
    content: { kind: 'message', body, html: body, emote: false, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
  };
}

export function timelineMessage(id: string, sender: string, timestamp: number, body: string) {
  return { ...timelineItem(id, body), sender, sender_name: sender, timestamp };
}

export function timelineImage(id: string) {
  return {
    ...timelineItem(id, 'History image'),
    content: {
      kind: 'image',
      body: 'History image',
      source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
      mime: 'image/png',
      // Matches TIMELINE_LAYOUT.pictureRatio, so the placeholder the estimator
      // reserves is the height the loaded image takes.
      width: 800,
      height: 600,
    },
  };
}

export function historyItems(options: {
  idPrefix: string;
  label: string;
  count: number;
  timestampBase: number;
  body?: (index: number) => string;
}) {
  const { idPrefix, label, count, timestampBase, body } = options;
  return Array.from({ length: count }, (_, index) => ({
    ...timelineItem(
      `${idPrefix}-${String(index)}`,
      body ? body(index) : `${label} ${String(index)}`
    ),
    sender: '@bob:example.test',
    sender_name: 'Bob',
    timestamp: timestampBase + index,
  }));
}
