// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { RecentReactions } from '#lib/emoji/recents.svelte.js';

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
  core.rpc.messages.frequentReactions.mockResolvedValue([]);
  vi.restoreAllMocks();
});

test('renders a suggested custom reaction as its emote image', async () => {
  core.rpc.messages.frequentReactions.mockResolvedValue(['mxc://example.org/neocat']);
  core.rpc.packs.list.mockResolvedValue({ packs, complete: true });

  render(MessageQuickReactionsHarness, {
    count: 1,
    onReact: vi.fn(),
    roomId: '!room:example.org',
  });

  const button = await screen.findByRole('button', { name: ':neocat:' });
  await vi.waitFor(() => {
    expect(button.querySelector('.quick-reaction-image')).toBeInTheDocument();
  });
  expect(document.body).not.toHaveTextContent('mxc://example.org/neocat');
});

test('shows the shared history on the first frame instead of the defaults', async () => {
  core.rpc.messages.frequentReactions.mockResolvedValue(['🐈']);
  let history!: RecentReactions;
  const stop = $effect.root(() => {
    history = new RecentReactions(
      core as unknown as ConstructorParameters<typeof RecentReactions>[0]
    );
  });
  await vi.waitFor(() => {
    expect(history.current).toEqual(['🐈']);
  });

  const { container } = render(MessageQuickReactionsHarness, {
    count: 1,
    onReact: vi.fn(),
    history,
  });

  expect(container.querySelector('.quick-reaction')).toHaveTextContent('🐈');
  stop();
});
