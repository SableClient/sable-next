// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView, MemberView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

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
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('uses a custom emote shortcode rather than its Matrix media URI', async () => {
  Object.assign(core.commands, { imagePacks: vi.fn(() => Promise.resolve(packs)) });

  const instance = mount(MessageReactionsHarness, {
    target: document.body,
    props: {
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
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('.reaction')?.getAttribute('aria-label')).toContain(':neocat:');
  });
  expect(document.body.textContent).not.toContain('mxc://example.org/neocat');

  await tick();
  await unmount(instance);
});
