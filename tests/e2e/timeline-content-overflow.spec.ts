import type { TimelineItemView } from '#src/generated/protocol';
import { expect, SIGNED_OUT, test } from './fixtures/test';
import { timelineImage, timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

const long = 'UnbrokenContent'.repeat(30);
const source = JSON.stringify({ Plain: 'mxc://example.test/history-image' });
const message = (html: string): TimelineItemView => ({
  ...timelineItem('general-19', long),
  content: { kind: 'message', body: long, html, emote: false, notice: false, edited: false },
});
const alteredMessage = (flags: { emote?: boolean; notice?: boolean; edited?: boolean }) => {
  const item = message(`<p>${long}</p>`);
  if (item.content.kind === 'message') Object.assign(item.content, flags);
  return item;
};
const cases: Record<string, TimelineItemView> = {
  text: message(`<p>${long}</p>`),
  emote: alteredMessage({ emote: true }),
  notice: alteredMessage({ notice: true }),
  edited: alteredMessage({ edited: true }),
  url: message(`<a href="https://example.test/${long}">https://example.test/${long}</a>`),
  'inline code': message(`<p><code>${long}</code></p>`),
  'code block': message(`<pre><code>${long}</code></pre>`),
  table: message(`<table><tr>${`<td>${long}</td>`.repeat(20)}</tr></table>`),
  quote: message(`<blockquote><h1>${long}</h1><ul><li>${long}</li></ul></blockquote>`),
  'matrix mention': message(`<a href="https://matrix.to/#/@long:example.test">${long}</a>`),
  maths: message(`<div data-mx-maths="${'x+'.repeat(100)}x"></div>`),
  'inline maths': message(`<span data-mx-maths="\\mathrm{${long}}"></span>`),
  persona: {
    ...alteredMessage({ emote: true }),
    per_message_profile: {
      id: 'persona',
      display_name: long,
      avatar_url: null,
      pronouns: [{ summary: long, language: null }],
      color_on_light: null,
      color_on_dark: null,
      has_fallback: false,
    },
  },
  'link preview': {
    ...message('<a href="https://example.test/preview">Preview</a>'),
    bundled_link_previews: [
      {
        url: 'https://example.test/preview',
        title: long,
        description: long,
        site_name: long,
        image: null,
        image_mime: null,
        image_width: null,
        image_height: null,
      },
    ],
  },
  reactions: {
    ...message('Reactions'),
    reactions: [{ key: long, senders: ['@alice:example.test'] }],
  },
  reply: {
    ...message('Reply'),
    in_reply_to: {
      event_id: '$general-1:example.test',
      sender: '@alice:example.test',
      sender_name: long,
      sender_mentioned: false,
      body: long,
    },
  },
  image: timelineImage('general-19'),
  video: {
    ...message(''),
    content: {
      kind: 'video',
      filename: long,
      caption: long,
      html: null,
      source,
      mime: 'video/mp4',
      width: 6000,
      height: 100,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
    },
  },
  audio: {
    ...message(''),
    content: {
      kind: 'audio',
      filename: long,
      caption: long,
      html: null,
      source: JSON.stringify({ Plain: 'mxc://example.test/overflow-audio' }),
      mime: 'audio/wav',
      duration_ms: 1000,
      waveform: [0.2, 0.8],
      voice: true,
      metadata: null,
    },
  },
  gallery: {
    ...message(''),
    content: {
      kind: 'gallery',
      body: long,
      html: `<p>${long}</p>`,
      items: [
        {
          kind: 'image',
          filename: long,
          caption: long,
          source,
          mime: 'image/png',
          width: 6000,
          height: 100,
          size: null,
          blurhash: null,
          thumbnail: null,
          spoiler: null,
        },
      ],
    },
  },
  sticker: {
    ...message(''),
    content: { kind: 'sticker', body: long, source, mime: 'image/png', width: 6000, height: 100 },
  },
  file: {
    ...message(''),
    content: {
      kind: 'file',
      filename: long,
      caption: long,
      html: null,
      source,
      mime: null,
      size: 123,
    },
  },
  poll: {
    ...message(''),
    content: {
      kind: 'poll',
      poll: {
        question: long,
        answers: [{ id: 'answer', text: long, votes: 0, selected: false, voters: [] }],
        max_selections: 1,
        undisclosed: false,
        ended_at: null,
        edited: false,
      },
    },
  },
  location: {
    ...message(''),
    content: {
      kind: 'location',
      body: long,
      geo_uri: 'geo:48.8,2.3',
      latitude: 48.8,
      longitude: 2.3,
    },
  },
  'live location': {
    ...message(''),
    content: {
      kind: 'live_location',
      body: long,
      latitude: 48.8,
      longitude: 2.3,
      live: false,
      expires_at: 0,
      updated_at: null,
    },
  },
  thread: {
    ...message('Thread'),
    thread_summary: {
      num_replies: 12,
      latest_event_id: '$reply:example.test',
      latest_body: long,
    },
  },
  'moderation notice': {
    ...message(''),
    content: {
      kind: 'membership',
      user_id: '@departed:example.test',
      display_name: long,
      change: 'kicked_and_banned',
      reason: long,
    },
  },
  'room topic': {
    ...message(''),
    content: {
      kind: 'state_event',
      event_type: 'm.room.topic',
      state_key: '',
      content: null,
      prev_content: null,
      change: { kind: 'room_topic', topic: long },
    },
  },
  redaction: { ...message(''), content: { kind: 'redacted', reason: long } },
  'raw state': {
    ...message(''),
    content: {
      kind: 'state_event',
      event_type: long,
      state_key: long,
      content: { [long]: long },
      prev_content: null,
      change: null,
    },
  },
  'profile change': {
    ...message(''),
    content: {
      kind: 'profile_change',
      user_id: '@oversized:example.test',
      display_name: { old: long, new: long + 'Changed' },
      avatar: null,
    },
  },
  malformed: { ...message(''), content: { kind: 'malformed', event_type: long } },
  unsupported: { ...message(''), content: { kind: 'unsupported', description: long } },
};

for (const layout of ['modern', 'compact', 'bubble'] as const) {
  for (const { width, zoom } of [
    { width: 320, zoom: 1 },
    { width: 390, zoom: 1 },
    { width: 390, zoom: 1.5 },
    { width: 1280, zoom: 1 },
  ]) {
    test(`mobile: oversized content stays within a ${width}px ${layout} timeline at ${zoom} zoom`, async ({
      page,
      app,
      core,
      timeline,
      installRoomCore,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        ({ layout, zoom }) => {
          localStorage.setItem(
            'sable-preferences',
            JSON.stringify({
              layout,
              pageZoom: zoom,
              hideProfileChanges: false,
              showHiddenEvents: true,
            })
          );
        },
        { layout, zoom }
      );
      await installRoomCore('ready');
      await app.openRoom('!room:example.test');
      await timeline.expectRevealed();
      // The fake core supplies PNG bytes for audio and video.
      await page.evaluate(() => {
        const policy = document.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content = "media-src 'none'";
        document.head.append(policy);
      });
      const subscription = await core.subscription();
      let previousId = 'general-19';

      for (const [label, item] of Object.entries(cases)) {
        for (const own of [false, true]) {
          await test.step(`${label} (${own ? 'sent' : 'received'})`, async () => {
            const id = `overflow-${label.replaceAll(' ', '-')}-${String(own)}`;
            await core.setTimelineItemById(subscription, previousId, {
              ...item,
              id,
              sender: own ? '@e2e:example.test' : '@oversized:example.test',
              sender_name: long,
              is_own: own,
              read_by: ['@bob:example.test', '@alice:example.test'],
            });
            previousId = id;
            await expect(timeline.itemById(id)).toBeVisible();
            const header = await timeline.itemById(id).evaluate((node) => {
              const name = node.querySelector('header .sender-identity');
              const details = node.querySelector('header .message-details');
              return name && details
                ? {
                    nameRight: name.getBoundingClientRect().right,
                    nameLeft: name.getBoundingClientRect().left,
                    detailsLeft: details.getBoundingClientRect().left,
                    detailsRight: details.getBoundingClientRect().right,
                  }
                : null;
            });
            if (header)
              expect(
                header.nameRight <= header.detailsLeft + 1 ||
                  header.detailsRight <= header.nameLeft + 1
              ).toBe(true);
            if (label.includes('maths'))
              await expect(timeline.itemById(id).locator('.katex')).toBeVisible();
            if (label === 'image' || label === 'sticker' || label === 'gallery') {
              await expect(timeline.itemById(id).locator('img').first()).toBeVisible();
            }
            await expect(async () => {
              const size = await timeline.viewport.evaluate((node) => ({
                available: node.clientWidth,
                content: node.scrollWidth,
              }));
              expect(size.content, label).toBeLessThanOrEqual(size.available + 1);
            }).toPass({ timeout: 2_000 });
            if (label === 'code block' || label === 'table' || label.includes('maths')) {
              const scroller = timeline
                .itemById(id)
                .locator(
                  label === 'code block'
                    ? 'pre'
                    : label === 'table'
                      ? '.table-scroll'
                      : '[data-mx-maths]'
                );
              await expect(scroller).toHaveCSS('overflow-x', 'auto');
              await expect
                .poll(() => scroller.evaluate((node) => node.scrollWidth - node.clientWidth), {
                  message: label,
                })
                .toBeGreaterThan(0);
              if (label === 'table') {
                const lines = await timeline
                  .itemById(id)
                  .locator('td')
                  .first()
                  .evaluate((node) => {
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
                      .size;
                  });
                expect(lines).toBe(1);
              }
            }
          });
        }
      }
    });
  }
}
