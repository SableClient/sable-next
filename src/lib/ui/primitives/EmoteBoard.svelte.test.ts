// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/emoji/load-packs.js', () => ({
  isPackChange: () => false,
  loadPacks: vi.fn(
    (_commands: unknown, _roomId: string, apply: (packs: unknown[]) => void): Promise<boolean> => {
      apply([
        {
          id: 'pack',
          origin: 'room',
          room_id: '!room:example.org',
          name: 'Pack',
          avatar_url: null,
          declared_name: 'Pack',
          declared_avatar_url: null,
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
          stable_event: true,
          legacy_event: false,
        },
      ]);
      return Promise.resolve(true);
    }
  ),
}));

import { core } from '#lib/core/__mocks__/context.js';

import EmoteBoard from './EmoteBoard.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
});

test('requests pack images unthumbnailed so animated emotes animate', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  render(EmoteBoard, { props: { roomId: '!room:example.org', onPick: vi.fn() } });

  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalled();
  });
  await tick();

  const requests = core.fetchMedia.mock.calls as unknown[][];
  expect(requests.filter(([source]) => source === 'mxc://example.org/wave')).not.toHaveLength(0);
  for (const [, width, height] of requests) {
    expect([width, height]).toEqual([0, 0]);
  }
});
