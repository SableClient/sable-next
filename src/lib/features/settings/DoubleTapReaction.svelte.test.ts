// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type ImagePackView, createRpc } from '#src/generated/protocol';
import type { Transport } from '#src/transport';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { createMedia } from '#lib/core/media.svelte.js';
import { useCoreClient } from '#lib/core/context.js';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
import DoubleTapReaction from './DoubleTapReaction.svelte';

vi.mock('#lib/core/context.js', () => ({ useCoreClient: vi.fn() }));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setPreference('doubleTapReaction', '❤️');
});

const packs: ImagePackView[] = [
  {
    id: '',
    origin: 'account',
    room_id: null,
    name: 'Personal pack',
    avatar_url: null,
    declared_name: null,
    declared_avatar_url: null,
    stable_event: false,
    legacy_event: false,
    attribution: null,
    usage: ['emoticon'],
    images: [
      {
        shortcode: 'wave',
        url: 'mxc://example.org/wave',
        body: null,
        usage: ['emoticon'],
        info: null,
        source_pack: null,
      },
    ],
  },
];

describe.each(['mobile', 'desktop'])('%s picker', (layout) => {
  test.each([
    { query: 'fire', role: 'gridcell', name: 'fire', reaction: '🔥' },
    { query: 'wave', role: 'button', name: ':wave:', reaction: 'mxc://example.org/wave' },
  ])('selects $query', async ({ query, role, name, reaction }) => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(48);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(48);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 48, 48)
    );
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
      const media = matchMedia(query);
      if (query === BREAKPOINTS.wide) {
        Object.defineProperty(media, 'matches', { value: layout === 'desktop' });
      }
      return media;
    });
    const call = vi.fn((method: string, params: { room_id?: string }) => {
      if (method === 'packs.list' && params.room_id === '') {
        return Promise.reject(new Error('invalid room ID'));
      }
      if (method === 'packs.list_all') return Promise.resolve(packs);
      if (method === 'messages.frequent_reactions') return Promise.resolve([]);
      if (method === 'messages.recent_stickers') return Promise.resolve([]);
      throw new Error(`Unexpected call: ${method}`);
    });
    const transport = { call, fetchMedia: () => new Promise(() => {}) } as unknown as Transport;
    vi.mocked(useCoreClient).mockReturnValue({
      media: createMedia(() => transport),
      rpc: createRpc((method, params) => transport.call(method, params)),
      session: null,
      subscribeEvents: () => () => {},
    } as unknown as CoreClient);
    render(DoubleTapReaction);

    await fireEvent.click(screen.getByRole('button', { name: 'Double tap reaction' }));
    await fireEvent.input(await screen.findByRole('searchbox'), { target: { value: query } });
    const choice = await screen.findByRole(role, { name });
    expect(screen.queryByText('Could not load packs.')).not.toBeInTheDocument();
    await fireEvent.click(choice);

    expect(preferences.doubleTapReaction).toBe(reaction);
    expect(call.mock.calls.filter(([method]) => method === 'packs.list_all')).toEqual([
      ['packs.list_all', {}],
    ]);
  });
});
