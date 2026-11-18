import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});
vi.mock('#lib/config/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/config/runtime-config.js')>()),
  runtimeConfig: () => Promise.resolve({ embeds: { serviceUrl: 'https://embeds.test' } }),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';
import { TIMELINE_LAYOUT_STYLE } from '#lib/features/room/timeline/timeline-layout.js';
import TimelineItemHarness from '#lib/features/room/timeline/TimelineItemHarness.test.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';

afterEach(async () => {
  preferences.clientEmbeds = false;
  preferences.youtubeEmbeds = false;
  document.body.removeAttribute('style');
  vi.unstubAllGlobals();
  await page.viewport(414, 800);
});

test('a video with a long title stays inside a narrow bubble timeline', async () => {
  await page.viewport(360, 800);
  document.body.style.cssText = TIMELINE_LAYOUT_STYLE;
  preferences.clientEmbeds = true;
  preferences.youtubeEmbeds = true;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          title: 'A video whose title runs well past the width of a phone screen in one line',
          author_name: 'A channel',
        })
      )
    )
  );
  const url = 'https://youtu.be/aaaaaaaaaaa';
  const item: TimelineItemView = withRowFields({
    id: 'video',
    event_id: '$video:example.test',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.test',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: url,
      html: `<a href="${url}">${url}</a>`,
      msgtype: 'text',
      edited: false,
      jumbo: null,
    },
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
  });
  await render(TimelineItemHarness, {
    core,
    item: { item, collapsed: false, layout: 'bubble', encrypted: false },
  });

  await expect.poll(() => document.querySelector('.youtube-embed')).not.toBeNull();
  const embed = document.querySelector('.youtube-embed')?.getBoundingClientRect();
  if (!embed) throw new Error('the embed is not rendered');
  expect(embed.right).toBeLessThanOrEqual(360);
});
