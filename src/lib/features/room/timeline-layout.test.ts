import { afterEach, expect, test, vi } from 'vitest';

import type { GalleryItemView } from '#src/generated/GalleryItemView';
import type { TimelineItemContentView } from '#src/generated/TimelineItemContentView';
import type { TimelineItemView } from '#src/generated/TimelineItemView';

import {
  codeBlockHeight,
  estimateTimelineItemSize,
  rootFontSize,
  TIMELINE_LAYOUT,
  TIMELINE_LAYOUT_STYLE,
} from './timeline-layout';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('publishes the estimator media dimensions as inherited CSS properties', () => {
  expect(TIMELINE_LAYOUT_STYLE).toBe('--timeline-media-max:25rem;--timeline-sticker-width:9.5rem');
});

test('reads a valid root font size and falls back for invalid values', () => {
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '20px' }));
  expect(rootFontSize()).toBe(20);
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: 'invalid' }));
  expect(rootFontSize()).toBe(16);
});

function media(
  kind: 'image' | 'video',
  width: number | null,
  height: number | null
): TimelineItemView {
  return {
    id: kind,
    event_id: `$${kind}`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind, body: '', source: 'mxc://example.org/media', mime: null, width, height },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    mention: 'none',
  };
}

function message(id: string, sender: string, timestamp: number): TimelineItemView {
  return {
    id,
    event_id: `$${id}`,
    transaction_id: null,
    send_state: null,
    sender,
    sender_name: sender,
    sender_avatar: null,
    timestamp,
    content: {
      kind: 'message',
      body: 'Hello',
      html: '<p>Hello</p>',
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
    per_message_profile: null,
    mention: 'none',
  };
}

test('uses intrinsic video geometry when available', () => {
  const item = media('video', 1920, 1080);
  const rem = 16;
  const mediaWidth = Math.max(
    TIMELINE_LAYOUT.mediaMinRem * rem,
    (TIMELINE_LAYOUT.mediaMaxRem - TIMELINE_LAYOUT.messageInsetRem) * rem
  );
  expect(estimateTimelineItemSize([item], 0, TIMELINE_LAYOUT.mediaMaxRem * rem, rem)).toBe(
    mediaWidth * (9 / 16) + TIMELINE_LAYOUT.messageChromeRem * rem
  );
});

test('uses an explicit fallback for videos without dimensions', () => {
  const item = media('video', null, null);
  const rem = 16;
  expect(estimateTimelineItemSize([item], 0, TIMELINE_LAYOUT.mediaMaxRem * rem, rem)).toBe(
    Math.max(
      TIMELINE_LAYOUT.mediaMinRem * rem,
      (TIMELINE_LAYOUT.mediaMaxRem - TIMELINE_LAYOUT.messageInsetRem) * rem
    ) *
      TIMELINE_LAYOUT.videoRatio +
      TIMELINE_LAYOUT.messageChromeRem * rem
  );
});

test('a message with no code block costs nothing extra', () => {
  expect(codeBlockHeight('<p>plain</p>', 16)).toBe(0);
});

test('estimates a collapsed modern message with its retained trailing spacing', () => {
  const rem = 16;
  const items = [message('one', '@alice:example.org', 0), message('two', '@alice:example.org', 1)];

  expect(estimateTimelineItemSize(items, 1, 800, rem)).toBe(
    TIMELINE_LAYOUT.collapsedMessageRem * rem
  );
});

test('a code block is measured by its lines and capped at the collapse limit', () => {
  const rem = 16;
  const short = codeBlockHeight(`<pre><code>${'a\n'.repeat(3)}</code></pre>`, rem);
  const long = codeBlockHeight(`<pre><code>${'a\n'.repeat(400)}</code></pre>`, rem);

  expect(short).toBeGreaterThan(0);
  expect(long).toBeGreaterThan(short);
  expect(long).toBe(
    TIMELINE_LAYOUT.codeLineLimit * TIMELINE_LAYOUT.codeLineRem * rem +
      TIMELINE_LAYOUT.codeChromeRem * rem
  );
});

test('every block in a message counts', () => {
  const one = codeBlockHeight('<pre><code>a</code></pre>', 16);
  expect(codeBlockHeight('<pre><code>a</code></pre><pre><code>b</code></pre>', 16)).toBe(one * 2);
});

/** `satisfies` fails to compile when the core gains a kind this list omits. */
const ALL_KINDS = [
  'message',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'location',
  'gallery',
  'poll',
  'redacted',
  'unable_to_decrypt',
  'membership',
  'profile_change',
  'state_event',
  'hidden_event',
  'date_divider',
  'read_marker',
  'timeline_start',
  'unsupported',
] as const satisfies readonly TimelineItemContentView['kind'][];

function contentOfKind(kind: TimelineItemContentView['kind']): TimelineItemContentView {
  const media = { body: '', source: 'mxc://example.org/m', mime: null, width: 8, height: 8 };
  switch (kind) {
    case 'message':
      return { kind, body: 'hi', html: 'hi', emote: false, notice: false, edited: false };
    case 'image':
    case 'video':
    case 'sticker':
      return { kind, ...media };
    case 'audio':
    case 'file':
      return { kind, body: '', source: media.source, mime: null };
    case 'location':
      return { kind, body: 'Big Ben', geo_uri: 'geo:51.5,-0.12', latitude: 51.5, longitude: -0.12 };
    case 'gallery':
      return { kind, body: '', html: '', items: [{ kind: 'image', ...media }] };
    case 'poll':
      return {
        kind,
        poll: {
          question: 'lunch?',
          answers: [{ id: '0', text: 'ramen', votes: 1, selected: false }],
          max_selections: 1,
          undisclosed: false,
          ended_at: null,
          edited: false,
        },
      };
    case 'redacted':
      return { kind };
    case 'unable_to_decrypt':
      return { kind, reason: 'undecryptable' };
    case 'membership':
      return { kind, user_id: '@a:b', change: 'joined', display_name: null };
    case 'profile_change':
      return { kind, user_id: '@a:b', display_name: null, avatar_changed: true };
    case 'state_event':
      return { kind, event_type: 'm.room.topic', state_key: '', content: null, change: null };
    case 'hidden_event':
      return { kind, event_type: 'm.key.verification.start', content: null };
    case 'date_divider':
      return { kind, timestamp: 0 };
    case 'read_marker':
    case 'timeline_start':
      return { kind };
    case 'unsupported':
      return { kind, description: 'live location' };
  }
}

test.each(ALL_KINDS)('estimates a height for %s', (kind) => {
  const item = { ...message('x', '@a:b', 0), content: contentOfKind(kind) };

  expect(estimateTimelineItemSize([item], 0)).toBeGreaterThan(0);
});

test('a poll grows with its answer count', () => {
  const one = { ...message('p', '@a:b', 0), content: contentOfKind('poll') };
  const three = structuredClone(one);
  if (three.content.kind !== 'poll') throw new Error('poll fixture');
  three.content.poll.answers = ['0', '1', '2'].map((id) => ({
    id,
    text: id,
    votes: 0,
    selected: false,
  }));

  expect(estimateTimelineItemSize([three], 0)).toBeGreaterThan(estimateTimelineItemSize([one], 0));
});

test('a worded state change is a one-line row, an unworded one keeps the peek', () => {
  const worded = { ...message('s', '@a:b', 0), content: contentOfKind('state_event') };
  if (worded.content.kind !== 'state_event') throw new Error('state fixture');
  worded.content.change = { kind: 'room_topic', topic: 'what we do' };

  const unworded = { ...message('s', '@a:b', 0), content: contentOfKind('state_event') };

  expect(estimateTimelineItemSize([worded], 0)).toBe(TIMELINE_LAYOUT.stateRowRem * 16);
  expect(estimateTimelineItemSize([unworded], 0)).toBe(TIMELINE_LAYOUT.debugRowRem * 16);
});

test('a location without coordinates is shorter than one with them', () => {
  const withCoords = { ...message('l', '@a:b', 0), content: contentOfKind('location') };
  const without = { ...message('l', '@a:b', 0), content: contentOfKind('location') };
  if (without.content.kind !== 'location') throw new Error('location fixture');
  without.content.latitude = null;
  without.content.longitude = null;

  expect(estimateTimelineItemSize([without], 0)).toBeLessThan(
    estimateTimelineItemSize([withCoords], 0)
  );
});

test('a gallery grows by row, not by item', () => {
  const tile: GalleryItemView = {
    kind: 'image',
    body: '',
    source: 'mxc://e/m',
    mime: null,
    width: 8,
    height: 8,
  };
  const size = (count: number) => {
    const item = { ...message('g', '@a:b', 0), content: contentOfKind('gallery') };
    if (item.content.kind !== 'gallery') throw new Error('gallery fixture');
    item.content.items = Array.from({ length: count }, () => ({ ...tile }));
    return estimateTimelineItemSize([item], 0);
  };

  // A lone tile spans the full width, so two half-width tiles are shorter.
  expect(size(2)).toBeLessThan(size(1));
  // A third opens a second row; the fourth fills it.
  expect(size(3)).toBeGreaterThan(size(2));
  expect(size(4)).toBe(size(3));
});
