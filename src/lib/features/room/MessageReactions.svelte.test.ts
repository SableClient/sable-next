// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView, MemberView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';

import MessageReactionsHarness from './MessageReactionsHarness.test.svelte';

const packs = [
  {
    id: 'cats',
    origin: 'account',
    room_id: null,
    name: 'Cats',
    avatar_url: null,
    attribution: null,
    usage: ['emoticon'],
    images: [
      {
        shortcode: 'neocat',
        url: 'mxc://example.org/neocat',
        body: null,
        usage: ['emoticon'],
        info: null,
        source_pack: null,
      },
    ],
  },
] satisfies ImagePackView[];

afterEach(() => {
  vi.restoreAllMocks();
});

test('uses a custom emote shortcode rather than its Matrix media URI', async () => {
  Object.assign(core.commands, { imagePacks: vi.fn(() => Promise.resolve(packs)) });

  render(MessageReactionsHarness, {
    reactions: [
      {
        key: 'mxc://example.org/neocat',
        senders: ['@alice:example.org'],
      },
    ] satisfies TimelineItemView['reactions'],
    eventId: '$event',
    currentUserId: null,
    members: [] as MemberView[],
    roomId: '!room:example.org',
    actionable: false,
  });

  expect(await screen.findByLabelText(/:neocat:/)).toHaveClass('reaction');
  expect(document.body).not.toHaveTextContent('mxc://example.org/neocat');
});

test('names an image from a pack we cannot see by the shortcode it was sent with', async () => {
  Object.assign(core.commands, {
    imagePacks: vi.fn(() => Promise.resolve([])),
    reactionShortcodes: vi.fn(() =>
      Promise.resolve([{ key: 'mxc://remote.example/parrot', shortcode: 'partyparrot' }])
    ),
  });

  render(MessageReactionsHarness, {
    reactions: [
      { key: 'mxc://remote.example/parrot', senders: ['@alice:example.org'] },
    ] satisfies TimelineItemView['reactions'],
    eventId: '$named',
    currentUserId: null,
    members: [] as MemberView[],
    roomId: '!room:example.org',
    actionable: false,
  });

  expect(await screen.findByLabelText(/:partyparrot:/)).toHaveClass('reaction');
});

test('shows the shortcode in place of an image that cannot load', async () => {
  Object.assign(core.commands, {
    imagePacks: vi.fn(() => Promise.resolve([])),
    reactionShortcodes: vi.fn(() =>
      Promise.resolve([{ key: 'mxc://dead.example/parrot', shortcode: 'partyparrot' }])
    ),
  });
  core.fetchMedia.mockRejectedValueOnce(new Error('unavailable'));

  render(MessageReactionsHarness, {
    reactions: [
      { key: 'mxc://dead.example/parrot', senders: ['@alice:example.org'] },
    ] satisfies TimelineItemView['reactions'],
    eventId: '$fallback',
    currentUserId: null,
    members: [] as MemberView[],
    roomId: '!room:example.org',
    actionable: false,
  });

  expect(await screen.findByText(':partyparrot:')).toHaveClass('reaction-shortcode');
});

test('a custom emote reaction shows its shortcode where media previews are off (MSC4278)', async () => {
  Object.assign(core.commands, { imagePacks: vi.fn(() => Promise.resolve(packs)) });
  mediaPreviewSettings.global = { media_previews: 'off' };

  render(MessageReactionsHarness, {
    reactions: [{ key: 'mxc://example.org/neocat', senders: ['@alice:example.org'] }],
    eventId: '$event',
    currentUserId: null,
    members: [],
    roomId: '!room:example.org',
    actionable: false,
    joinRule: 'invite',
  });

  expect(await screen.findByText(':neocat:')).toHaveClass('reaction-shortcode');
  expect(document.querySelector('.reaction-image')).toBeNull();
  mediaPreviewSettings.global = {};
});
