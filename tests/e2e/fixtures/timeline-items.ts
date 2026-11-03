// These shapes must track TimelineItemContentView in src/generated/protocol.ts; the app
// reads content.html, so a body-only override renders the previous text.
import type { TimelineItemView } from '#src/generated/protocol';
import { timelineItem as makeTimelineItem } from '../../../src/lib/features/room/timeline/test-items';

import { withRowFields } from '../../../src/lib/features/room/timeline/row-fixtures';

export { withRowFields };

export const timelineItem = (id: string, body: string): TimelineItemView =>
  makeTimelineItem(id, body, {
    eventId: `$${id}:example.test`,
    sender: '@alice:example.test',
    timestamp: 1_700_000_000_000,
  });

export function readMarkerItem(id: string): TimelineItemView {
  return withRowFields({
    ...timelineItem(id, ''),
    event_id: null,
    sender: null,
    sender_name: null,
    content: { kind: 'read_marker' },
  });
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
      source: 'mxc://example.test/history-image',
      external_url: null,
      mime: 'image/png',
      size: null,
      blurhash: null,
      thumbnail: null,
      // Matches TIMELINE_LAYOUT.pictureRatio, so the placeholder the estimator
      // reserves is the height the loaded image takes.
      width: 800,
      height: 600,
      spoiler: null,
      animated: null,
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
      external_url: null,
      mime: 'image/png',
      size: null,
      blurhash: null,
      thumbnail: null,
      width: null,
      height: null,
      spoiler: null,
      animated: null,
    },
  };
}
