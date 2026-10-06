// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { adoptRecentReactions } from '#lib/emoji/recents.svelte.js';

import MessageQuickReactionsHarness from './MessageQuickReactionsHarness.test.svelte';

const packs = [
  {
    id: 'cats',
    origin: 'account',
    room_id: null,
    name: 'Cats',
    avatar_url: null,
    declared_name: null,
    declared_avatar_url: null,
    stable_event: false,
    legacy_event: false,
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
  adoptRecentReactions([]);
  vi.restoreAllMocks();
});

test('renders a suggested custom reaction as its emote image', async () => {
  adoptRecentReactions([{ emoji: 'mxc://example.org/neocat', total: 1 }]);

  render(MessageQuickReactionsHarness, {
    count: 1,
    loadImagePacks: () => Promise.resolve(packs),
    onReact: vi.fn(),
    roomId: '!room:example.org',
  });

  const button = await screen.findByRole('button', { name: ':neocat:' });
  await vi.waitFor(() => {
    expect(button.querySelector('.quick-reaction-image')).toBeInTheDocument();
  });
  expect(document.body).not.toHaveTextContent('mxc://example.org/neocat');
});
