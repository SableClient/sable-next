// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Command, ImagePackView } from '#src/generated/protocol';
import type { Transport } from '#src/transport';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCommands } from '#lib/core/commands.svelte.js';
import { useCoreClient } from '#lib/core/context.js';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
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
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
      const media = matchMedia(query);
      Object.defineProperty(media, 'matches', { value: layout === 'desktop' });
      return media;
    });
    const send = vi.fn((command: Command) => {
      if (command.type === 'image_packs' && command.room_id === '') {
        return Promise.reject(new Error('invalid room ID'));
      }
      if (command.type === 'all_image_packs') {
        return Promise.resolve({ type: 'all_image_packs', packs });
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const transport = { send, fetchMedia: () => new Promise(() => {}) } as unknown as Transport;
    const commands = createCommands(() => transport);
    vi.mocked(useCoreClient).mockReturnValue({
      commands,
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
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'all_image_packs' });
  });
});
