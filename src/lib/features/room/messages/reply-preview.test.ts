import { expect, test } from 'vitest';

import type { PerMessageProfileView, TimelineItemContentView } from '#src/generated/protocol';
import { stripReplyFallback } from '#lib/features/room/members/members.js';
import { previewSegments, replyPreviewBody } from '#lib/features/room/messages/reply-preview.js';
import { markdownToContent } from '#lib/model/model.js';

const video: TimelineItemContentView = {
  kind: 'video',
  html: null,
  filename: 'clip.mp4',
  caption: null,
  source: '{}',
  external_url: null,
  mime: 'video/mp4',
  width: null,
  height: null,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
  playback: null,
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
    replyPreviewBody({
      kind: 'message',
      body,
      html,
      msgtype: 'text',
      edited: false,
      jumbo: null,
    })
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
      external_url: null,
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
      external_url: null,
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
  expect(replyPreviewBody({ kind: 'redacted', reason: null, redacted_by: null })).toBe('');
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
      msgtype: 'text',
      edited: false,
      jumbo: null,
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

test('a formatted spoiler uses one placeholder while separate spoilers stay separate', () => {
  const { body, formatted_body: html } = markdownToContent(
    '||this is a *huge* spoiler|| and ||another||',
    [],
    'matrix.to'
  );

  expect(
    replyPreviewBody({
      kind: 'message',
      body,
      html: html ?? '',
      msgtype: 'text',
      edited: false,
      jumbo: null,
    })
  ).toBe('[Spoiler] and [Spoiler]');
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

test('a preview splits at each emote offset and leaves misplaced ones as text', () => {
  const a = (offset: number) => ({ alt: ':a:', source: 'mxc://x/a', offset });
  const b = (offset: number) => ({ alt: ':b:', source: 'mxc://x/b', offset });
  expect(previewSegments(':a: then :a: and :b:', [a(0), a(9), b(17)])).toEqual([
    a(0),
    ' then ',
    a(9),
    ' and ',
    b(17),
  ]);
  expect(previewSegments('no emotes here', [b(0)])).toEqual(['no emotes here']);
});

test('a preview places an emote where it was sent, not inside an earlier word', () => {
  const tf = (offset: number) => ({ alt: 'tf', source: 'mxc://x/tf', offset });
  const ac = { alt: 'ac', source: 'mxc://x/ac', offset: 13 };
  expect(previewSegments('i have a dirty maid outfit tf', [tf(27)])).toEqual([
    'i have a dirty maid outfit ',
    tf(27),
  ]);
  expect(previewSegments('tf is this tf', [tf(11)])).toEqual(['tf is this ', tf(11)]);
  expect(previewSegments('bbbbbacbbbbb ac', [ac])).toEqual(['bbbbbacbbbbb ', ac]);
});

test('emote offsets are UTF-16 units, as JS strings index', () => {
  const tf = { alt: 'tf', source: 'mxc://x/tf', offset: 8 };
  expect(previewSegments('café 🎉 tf', [tf])).toEqual(['café 🎉 ', tf]);
});

test('an emote cut off by truncation stays as text', () => {
  const tf = (offset: number) => ({ alt: 'tf', source: 'mxc://x/tf', offset });
  expect(previewSegments('a tf b t…', [tf(2), tf(7)])).toEqual(['a ', tf(2), ' b t…']);
  expect(previewSegments('a tf', [tf(2), tf(9)])).toEqual(['a ', tf(2)]);
});

test('an emote shifts with the text cut off the front of the preview', () => {
  const tf = (offset: number) => ({ alt: 'tf', source: 'mxc://x/tf', offset });
  expect(previewSegments('hi tf', [tf(2), tf(8)], 5)).toEqual(['hi ', tf(8)]);
});

test("a persona name cut off a reply moves the core's emote offsets with it", () => {
  // The core reads "<strong data-mx-profile-fallback>Cat: </strong>hi <img alt=tf>" as below.
  const full = 'Cat: hi tf';
  const tf = { alt: 'tf', source: 'mxc://x/tf', offset: 8 };
  const persona = { display_name: 'Cat', has_fallback: true } as PerMessageProfileView;
  const text = stripReplyFallback(full, persona);
  expect(previewSegments(text, [tf], full.length - text.length)).toEqual(['hi ', tf]);
});
