// These shapes must track TimelineItemContentView in src/generated/protocol.ts; the app
// reads content.html, so a body-only override renders the previous text.
import type { TimelineItemView } from '#src/generated/protocol';

export function timelineItem(id: string, body: string): TimelineItemView {
  return {
    id,
    event_id: `$${id}:example.test`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.test',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 1_700_000_000_000,
    content: { kind: 'message', body, html: body, emote: false, notice: false, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    bundled_link_previews: [],
    mention: 'none',
  };
}

export function readMarkerItem(id: string): TimelineItemView {
  return {
    ...timelineItem(id, ''),
    event_id: null,
    sender: null,
    sender_name: null,
    content: { kind: 'read_marker' },
  };
}

export function timelineMessage(
  id: string,
  sender: string,
  timestamp: number,
  body: string
): TimelineItemView {
  return { ...timelineItem(id, body), sender, sender_name: sender, timestamp };
}

export function timelineImage(id: string): TimelineItemView {
  return {
    ...timelineItem(id, 'History image'),
    content: {
      kind: 'image',
      filename: 'History image',
      caption: null,
      html: null,
      source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
      mime: 'image/png',
      size: null,
      blurhash: null,
      // Matches TIMELINE_LAYOUT.pictureRatio, so the placeholder the estimator
      // reserves is the height the loaded image takes.
      width: 800,
      height: 600,
      spoiler: null,
    },
  };
}

export function historyItems(options: {
  idPrefix: string;
  label: string;
  count: number;
  timestampBase: number;
  body?: (index: number) => string;
}): TimelineItemView[] {
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

export function timelineWideImageWithoutDimensions(id: string): TimelineItemView {
  return {
    ...timelineItem(id, 'History image'),
    content: {
      kind: 'image',
      filename: 'History image',
      caption: null,
      html: null,
      source: JSON.stringify({ Plain: 'mxc://example.test/wide-history-image' }),
      mime: 'image/png',
      size: null,
      blurhash: null,
      width: null,
      height: null,
      spoiler: null,
    },
  };
}
