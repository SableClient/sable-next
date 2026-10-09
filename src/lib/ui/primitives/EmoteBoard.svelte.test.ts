// @vitest-environment happy-dom

import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
          usage: ['emoticon', 'sticker'],
          images: [
            {
              shortcode: 'wave',
              url: 'mxc://example.org/wave',
              body: null,
              usage: ['emoticon', 'sticker'],
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
import { rememberEmote } from '#lib/emoji/recent-packs.svelte.js';

import EmoteBoard from './EmoteBoard.svelte';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 48, 48)
  );
});

afterEach(() => {
  core.fetchMedia.mockReset();
  vi.restoreAllMocks();
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

test('previews a search result on hover', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const { findByRole, container } = render(EmoteBoard, {
    props: { roomId: '!room:example.org', query: 'wav', onPick: vi.fn() },
  });

  const button = await findByRole('button', { name: ':wave:' });
  await fireEvent.pointerEnter(button);

  expect(container.querySelector('.preview code')?.textContent).toBe(':wave:');
});

test('previews a recent sticker on hover', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  rememberEmote('wave', 'sticker');
  const { findAllByRole, container } = render(EmoteBoard, {
    props: { roomId: '!room:example.org', tab: 'sticker', onPick: vi.fn() },
  });

  const [button] = await findAllByRole('button', { name: ':wave:' });
  await fireEvent.pointerEnter(button);

  expect(container.querySelector('.preview code')?.textContent).toBe(':wave:');
});

test('previews a recent emote on focus', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  rememberEmote('wave', 'emoticon');
  const { findAllByRole, container } = render(EmoteBoard, {
    props: { roomId: '!room:example.org', unicode: true, onPick: vi.fn() },
  });

  const [cell] = await findAllByRole('gridcell', { name: ':wave:' });
  await fireEvent.focus(cell);

  expect(container.querySelector('.preview code')?.textContent).toBe(':wave:');
});
