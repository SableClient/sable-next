import { expect, test } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import { galleryEventId, galleryItemId, timelineMediaItems } from './media-items.js';

function gallery(items: Extract<TimelineItemView['content'], { kind: 'gallery' }>['items']) {
  return {
    id: 'item',
    row: 'message',
    forwardable: true,
    redactable: true,
    visibility: 'always',
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
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    shared_by: null,
    redacted_on_ban: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
    shield: null,
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

test('lists videos so a GIF opened from the timeline is the one the viewer shows', () => {
  const clip = {
    kind: 'video',
    filename: 'clip.mp4',
    caption: null,
    source: 'mxc://example.org/clip',
    mime: 'video/mp4',
    width: null,
    height: null,
    blurhash: null,
    thumbnail: null,
    spoiler: null,
  } as const;
  const items = timelineMediaItems([gallery([clip])]);

  expect(items).toMatchObject([{ kind: 'video', eventId: '$gallery:gallery:0' }]);
});

test('a gallery item id leads back to its event', () => {
  expect(galleryEventId(galleryItemId('$gallery', 3))).toBe('$gallery');
  expect(galleryEventId('$plain:example.org')).toBe('$plain:example.org');
});

test('credits media to the per-message profile it was sent with', () => {
  const entry = {
    ...gallery([
      {
        kind: 'image',
        filename: 'a.png',
        caption: null,
        source: 'mxc://example.org/a',
        mime: 'image/png',
        width: null,
        height: null,
        size: null,
        blurhash: null,
        thumbnail: null,
        spoiler: null,
      },
    ]),
    per_message_profile: { id: 'p', display_name: 'Silver', avatar_url: null, pronouns: [] },
  } as unknown as TimelineItemView;

  expect(timelineMediaItems([entry])[0]?.sender).toBe('Silver');
});
