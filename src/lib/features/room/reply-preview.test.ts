import { expect, test } from 'vitest';

import type { TimelineItemContentView } from '#src/generated/TimelineItemContentView';
import { replyPreviewBody } from '#lib/features/room/reply-preview.js';

const video: TimelineItemContentView = {
  kind: 'video',
  body: 'clip.mp4',
  source: '{}',
  mime: 'video/mp4',
  width: null,
  height: null,
  blurhash: null,
  spoiler: null,
};

test('every renderable message kind yields a preview', () => {
  expect(replyPreviewBody(video)).toBe('clip.mp4');
  expect(
    replyPreviewBody({
      kind: 'audio',
      body: 'voice.ogg',
      source: '{}',
      mime: null,
      duration_ms: null,
      waveform: null,
      voice: true,
    })
  ).toBe('voice.ogg');
  expect(
    replyPreviewBody({ kind: 'file', body: 'deck.pdf', source: '{}', mime: null, size: null })
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
    })
  ).toBe('m.key.verification.start');
});
