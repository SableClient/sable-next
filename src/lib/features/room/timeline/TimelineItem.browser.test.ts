import { afterEach, expect, test, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { ProfileView, TimelineItemView } from '#src/generated/protocol';

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

import { core } from '#lib/core/__mocks__/context.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateColorScheme: (scheme: 'light' | 'dark') => Promise<void>;
  }
}

afterEach(async () => {
  await commands.emulateColorScheme('light');
  await page.viewport(414, 800);
  setPreference('replyPreviewStyle', 'connected');
});

const profile: ProfileView = {
  user_id: '@alice:example.test',
  display_name: 'Alice',
  avatar_url: null,
  bio: null,
  hero_color: null,
  hero_brightness: null,
  banner_url: null,
  status: null,
  pronouns: [],
  timezone: null,
  name_color_light: '#b0306a',
  name_color_dark: '#f09ac0',
  animal: null,
  extra: [],
  supporter_awards: null,
  legacy_fields: [],
};

function message(id: string, sender: string, senderName: string): TimelineItemView {
  return {
    id,
    event_id: `$${id}:example.test`,
    transaction_id: null,
    send_state: null,
    sender,
    sender_name: senderName,
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: `Message from ${senderName}`,
      html: `Message from ${senderName}`,
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
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
  };
}

function replyToAlice(id: string, sender: string, senderName: string): TimelineItemView {
  return {
    ...message(id, sender, senderName),
    in_reply_to: {
      event_id: '$general-1:example.test',
      sender: '@alice:example.test',
      sender_mentioned: false,
      sender_name: 'Alice',
      body: 'General message 1',
    },
  };
}

function mountItem(item: TimelineItemView, layout: 'modern' | 'compact' = 'modern') {
  core.userProfile.mockImplementation((userId: string) =>
    Promise.resolve(userId === profile.user_id ? profile : { ...profile, user_id: userId })
  );
  return render(TimelineItemHarness, {
    core,
    item: { item, collapsed: false, layout },
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a reply names its sender in the colour of their messages on the ${scheme} theme`, async () => {
    await commands.emulateColorScheme(scheme);
    await mountItem(message('alice-says', '@alice:example.test', 'Alice'));
    await mountItem(replyToAlice('reply-to-alice', '@e2e:example.test', 'E2E User'));

    await expect
      .poll(() =>
        document.querySelector('.reply-preview .reply-name, .reply-connected .reply-name')
      )
      .toHaveClass('tinted');
    const reply = document.querySelector('.reply-name');
    const header = document.querySelector('.sender-identity-name.tinted');
    if (!reply || !header) throw new Error('the reply or the header is not rendered');
    expect(getComputedStyle(reply).color).toBe(getComputedStyle(header).color);
  });
}

test('a compact connected reply keeps its connector clear of the name gutter', async () => {
  setPreference('replyPreviewStyle', 'connected');
  await mountItem(replyToAlice('compact-reply', '@bob:example.test', 'Bob'), 'compact');

  const row = document.querySelector('.message');
  const gutter = row?.querySelector('.compact-gutter');
  const reply = row?.querySelector('.reply-connected');
  if (!gutter || !reply) throw new Error('missing compact reply parts');
  const connectorLeft =
    reply.getBoundingClientRect().left + parseFloat(getComputedStyle(reply, '::before').left);
  expect(connectorLeft).toBeGreaterThanOrEqual(gutter.getBoundingClientRect().right);
});

test('a mobile connected reply aligns its preview text with the sender name', async () => {
  await page.viewport(390, 844);
  setPreference('replyPreviewStyle', 'connected');
  await mountItem(replyToAlice('aligned-reply', '@bob:example.test', 'Bob'));
  await document.fonts.ready;

  const reply = document.querySelector('.reply-connected');
  const name = reply?.querySelector('.reply-name');
  const body = reply?.querySelector('.reply-body');
  if (!name || !body) throw new Error('Missing reply text');
  const range = document.createRange();
  range.selectNodeContents(name);
  const nameTop = range.getBoundingClientRect().top;
  range.selectNodeContents(body);
  expect(Math.abs(nameTop - range.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
});
