// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
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
  document.body.replaceChildren();
  adoptRecentReactions([]);
  vi.restoreAllMocks();
});

test('renders a suggested custom reaction as its emote image', async () => {
  adoptRecentReactions([{ emoji: 'mxc://example.org/neocat', total: 1 }]);

  const instance = mount(MessageQuickReactionsHarness, {
    target: document.body,
    props: {
      count: 1,
      loadImagePacks: () => Promise.resolve(packs),
      onReact: vi.fn(),
      roomId: '!room:example.org',
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('.quick-reaction-image')).not.toBeNull();
    expect(document.querySelector('.quick-reaction')?.getAttribute('aria-label')).toBe(':neocat:');
  });
  const button = document.querySelector<HTMLButtonElement>('.quick-reaction');
  expect(button?.getAttribute('aria-label')).toBe(':neocat:');
  expect(document.body.textContent).not.toContain('mxc://example.org/neocat');

  await tick();
  await unmount(instance);
});
