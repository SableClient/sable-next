import { expect, test } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import { timelineMediaItems } from './media-items.js';

function gallery(items: Extract<TimelineItemView['content'], { kind: 'gallery' }>['items']) {
  return {
    id: 'item',
    event_id: '$gallery',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'gallery', body: '', html: '', items },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    bundled_link_previews: [],
    mention: 'none',
  } satisfies TimelineItemView;
}

test('lists a gallery pdf as a file the viewer can open, and skips other files', () => {
  const items = timelineMediaItems([
    gallery([
      {
        kind: 'image',
        filename: 'one.png',
        caption: null,
        source: 'mxc://example.org/one',
        mime: 'image/png',
        width: 100,
        height: 100,
        size: null,
        blurhash: null,
        thumbnail: null,
        spoiler: 'sunburn',
      },
      {
        kind: 'file',
        filename: 'archive.zip',
        caption: null,
        source: 'mxc://example.org/archive',
        mime: 'application/zip',
        size: null,
      },
      {
        kind: 'file',
        filename: 'report.pdf',
        caption: null,
        source: 'mxc://example.org/report',
        mime: 'application/pdf',
        size: 4096,
      },
    ]),
  ]);

  expect(items).toHaveLength(2);
  expect(items).toMatchObject([
    { kind: 'image', eventId: '$gallery:gallery:0', spoiler: 'sunburn' },
    {
      kind: 'file',
      eventId: '$gallery:gallery:2',
      filename: 'report.pdf',
      source: 'mxc://example.org/report',
      size: 4096,
    },
  ]);
});
