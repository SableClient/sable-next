import { expect, test } from 'vitest';

import type { TimelineItemContentView } from '#src/generated/protocol';
import { replyPreviewBody } from '#lib/features/room/messages/reply-preview.js';

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

test.each([
  ['***both***', '<strong><em>both</em></strong>', 'both'],
  ['``code ` tick``', '<code>code ` tick</code>', 'code ` tick'],
  ['[label](https://example.org)', '<a href="https://example.org">label</a>', 'label'],
  [
    '```rust\nlet x = 1;\n```',
    '<pre><code class="language-rust">let x = 1;</code></pre>',
    'let x = 1;',
  ],
  [
    'before\n```\n    a\n    b\n```\nafter',
    '<p>before</p><pre><code>    a\n    b</code></pre><p>after</p>',
    'before\n    a\n    b\nafter',
  ],
  [':rotate:', '<img data-mx-emoticon src="mxc://example.org/rotate" alt=":rotate:">', ':rotate:'],
  ['\\*literal\\*', '*literal*', '*literal*'],
  ['`<tag> & text`', '<code>&lt;tag&gt; &amp; text</code>', '<tag> & text'],
  ['plain **literal**', 'plain **literal**', 'plain **literal**'],
  ['fallback', '', 'fallback'],
])('a preview renders %s', (body, html, expected) => {
  expect(
    replyPreviewBody({ kind: 'message', body, html, emote: false, notice: false, edited: false })
  ).toBe(expected);
});

test('a caption without HTML keeps literal Markdown', () => {
  expect(replyPreviewBody({ ...video, caption: 'plain **literal**' })).toBe('plain **literal**');
});

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
  ).toBe('');
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
