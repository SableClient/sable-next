import { expect, test } from 'vitest';

import type { TimelineItemContentView } from '#src/generated/protocol';
import { replyPreviewBody } from '#lib/features/room/reply-preview.js';

const video: TimelineItemContentView = {
  kind: 'video',
  html: null,
  filename: 'clip.mp4',
  caption: null,
  source: '{}',
  mime: 'video/mp4',
  width: null,
  height: null,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
};

test('every renderable message kind yields a preview', () => {
  expect(replyPreviewBody(video)).toBe('clip.mp4');
  expect(
    replyPreviewBody({
      kind: 'audio',
      html: null,
      filename: 'voice.ogg',
      caption: null,
      source: '{}',
      mime: null,
      duration_ms: null,
      waveform: null,
      voice: true,
      metadata: null,
    })
  ).toBe('voice.ogg');
  expect(
    replyPreviewBody({
      kind: 'file',
      filename: 'deck.pdf',
      caption: null,
      html: null,
      source: '{}',
      mime: null,
      size: null,
    })
  ).toBe('deck.pdf');
  expect(
    replyPreviewBody({
      kind: 'poll',
      poll: {
        question: 'Lunch?',
        answers: [],
        max_selections: 1,
        undisclosed: false,
        ended_at: null,
        edited: false,
      },
    })
  ).toBe('Lunch?');
});

test('an event with no body still yields a quotable empty preview', () => {
  expect(replyPreviewBody({ kind: 'redacted', reason: null })).toBe('');
  expect(
    replyPreviewBody({
      kind: 'hidden_event',
      event_type: 'm.key.verification.start',
      content: null,
      redacts: null,
    })
  ).toBe('m.key.verification.start');
});

test('a spoiler stays hidden in the preview', () => {
  expect(
    replyPreviewBody({
      kind: 'message',
      body: 'look ||secret|| here',
      html: 'look <span data-mx-spoiler="">sec<b>ret</b></span> here &amp; there',
      emote: false,
      notice: false,
      edited: false,
    })
  ).toBe('look [Spoiler] here & there');
  expect(
    replyPreviewBody({
      ...video,
      caption: '||secret||',
      html: '<span data-mx-spoiler="">secret</span>',
    })
  ).toBe('[Spoiler]');
});

test('an uncaptioned gallery is quoted by its file names', () => {
  expect(
    replyPreviewBody({
      kind: 'gallery',
      body: '',
      html: '',
      items: [
        {
          kind: 'audio',
          filename: 'memo.ogg',
          caption: null,
          source: '{}',
          mime: null,
          duration_ms: null,
          waveform: null,
        },
        {
          kind: 'file',
          filename: 'notes.pdf',
          caption: null,
          source: '{}',
          mime: 'application/pdf',
          size: null,
        },
      ],
    })
  ).toBe('memo.ogg, notes.pdf');
});
