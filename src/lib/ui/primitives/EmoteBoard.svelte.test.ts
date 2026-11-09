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
            ...['wink', 'tada'].map((shortcode) => ({
              shortcode,
              url: `mxc://example.org/${shortcode}`,
              body: null,
              usage: ['emoticon', 'sticker'],
              info: null,
              source_pack: null,
            })),
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
import { rememberSticker, writeRecentStickers } from '#lib/emoji/recent-packs.svelte.js';

import EmoteBoard from './EmoteBoard.svelte';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 48, 48)
  );
});

afterEach(() => {
  writeRecentStickers([]);
  core.rpc.messages.frequentReactions.mockResolvedValue([]);
  core.rpc.messages.rememberEmoji.mockClear();
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
  rememberSticker('mxc://example.org/wave');
  const { findAllByRole, container } = render(EmoteBoard, {
    props: { roomId: '!room:example.org', tab: 'sticker', onPick: vi.fn() },
  });

  const [button] = await findAllByRole('button', { name: ':wave:' });
  await fireEvent.pointerEnter(button);

  expect(container.querySelector('.preview code')?.textContent).toBe(':wave:');
});

test('previews a recent emote on focus', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  core.rpc.messages.frequentReactions.mockResolvedValue(['mxc://example.org/wave']);
  const { findAllByRole, container } = render(EmoteBoard, {
    props: { roomId: '!room:example.org', unicode: true, onPick: vi.fn() },
  });

  const [cell] = await findAllByRole('gridcell', { name: ':wave:' });
  await fireEvent.focus(cell);

  expect(container.querySelector('.preview code')?.textContent).toBe(':wave:');
});

async function mountSearching(onPick = vi.fn()) {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const view = render(EmoteBoard, { props: { roomId: '!room:example.org', onPick } });
  const search = await view.findByRole('searchbox');
  await view.findByRole('button', { name: ':wave:' });
  search.focus();
  await tick();
  return { ...view, search, onPick };
}

const selectedLabel = (container: HTMLElement) =>
  container.querySelector('[data-selected]')?.getAttribute('aria-label');

test('selects the first emote when the search box is focused', async () => {
  const { container } = await mountSearching();

  expect(selectedLabel(container)).toBe(':wave:');
});

test('arrow keys move the selection and keep the text cursor still', async () => {
  const { container, search } = await mountSearching();

  const right = new KeyboardEvent('keydown', {
    key: 'ArrowRight',
    cancelable: true,
    bubbles: true,
  });
  search.dispatchEvent(right);
  await tick();
  expect(right.defaultPrevented).toBe(true);
  expect(selectedLabel(container)).toBe(':wink:');

  await fireEvent.keyDown(search, { key: 'ArrowRight' });
  await fireEvent.keyDown(search, { key: 'ArrowRight' });
  expect(selectedLabel(container)).toBe(':tada:');

  await fireEvent.keyDown(search, { key: 'ArrowLeft' });
  expect(selectedLabel(container)).toBe(':wink:');
});

test('ctrl shortcuts are left to the search box', async () => {
  const { container, search } = await mountSearching();

  const selectAll = new KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
  });
  search.dispatchEvent(selectAll);
  const ctrlRight = new KeyboardEvent('keydown', {
    key: 'ArrowRight',
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
  });
  search.dispatchEvent(ctrlRight);

  expect(selectAll.defaultPrevented).toBe(false);
  expect(ctrlRight.defaultPrevented).toBe(false);
  expect(selectedLabel(container)).toBe(':wave:');
});

test('typing selects the first result again', async () => {
  const { container, search } = await mountSearching();
  await fireEvent.keyDown(search, { key: 'ArrowRight' });
  expect(selectedLabel(container)).toBe(':wink:');

  await fireEvent.input(search, { target: { value: 'w' } });
  await tick();

  expect(selectedLabel(container)).toBe(':wave:');
});

test('arrow keys move the text cursor when nothing matches', async () => {
  const { search } = await mountSearching();
  await fireEvent.input(search, { target: { value: 'zzz' } });
  await tick();

  const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true, bubbles: true });
  search.dispatchEvent(left);

  expect(left.defaultPrevented).toBe(false);
});

test('enter picks the selected emote and closes', async () => {
  const { search, onPick } = await mountSearching();
  await fireEvent.keyDown(search, { key: 'ArrowRight' });

  await fireEvent.keyDown(search, { key: 'Enter' });

  expect(onPick).toHaveBeenCalledWith(
    expect.objectContaining({ shortcode: 'wink' }),
    'emoticon',
    false
  );
  expect(core.rpc.messages.rememberEmoji).toHaveBeenCalledWith({ key: 'mxc://example.org/wink' });
});

test('shift+enter picks the selected emote and keeps the board open', async () => {
  const editor = document.body.appendChild(document.createElement('button'));
  const { search, onPick } = await mountSearching(
    vi.fn(() => {
      editor.focus();
    })
  );

  await fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });

  expect(onPick).toHaveBeenCalledWith(
    expect.objectContaining({ shortcode: 'wave' }),
    'emoticon',
    true
  );
  await tick();
  expect(search).toHaveFocus();
  editor.remove();
});

test('enter reacts with the typed text over a matching emote', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const onPickUnicode = vi.fn();
  const view = render(EmoteBoard, {
    props: {
      roomId: '!room:example.org',
      unicode: true,
      reactions: true,
      onPick: vi.fn(),
      onPickUnicode,
    },
  });
  const search = await view.findByRole('searchbox');
  search.focus();
  await fireEvent.input(search, { target: { value: 'smile' } });
  await tick();

  await fireEvent.keyDown(search, { key: 'Enter' });

  expect(onPickUnicode).toHaveBeenCalledWith('smile', false);
});

test('announces what enter will react with', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const view = render(EmoteBoard, {
    props: {
      roomId: '!room:example.org',
      unicode: true,
      reactions: true,
      onPick: vi.fn(),
      onPickUnicode: vi.fn(),
    },
  });
  const search = await view.findByRole('searchbox');
  search.focus();
  await fireEvent.input(search, { target: { value: 'smile' } });
  await tick();
  const status = view.container.querySelector('[role="status"]');
  expect(status?.textContent).toContain('smile');

  await fireEvent.keyDown(search, { key: 'ArrowRight' });

  expect(status?.textContent).not.toContain('React with');
});

test('the reaction picker uses the core ranking beyond six entries', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const keys = ['😂', '❤️', '👍', '✅', '🔥', '🎉', 'mxc://example.org/wave'];
  core.rpc.messages.frequentReactions.mockResolvedValue(keys);
  const view = render(EmoteBoard, {
    props: { roomId: '!room:example.org', unicode: true, reactions: true, onPick: vi.fn() },
  });
  await vi.waitFor(() => {
    const cells = view.container.querySelectorAll('[data-section="recent"] [role="gridcell"]');
    expect(cells).toHaveLength(7);
    expect(cells[6]).toHaveAttribute('aria-label', ':wave:');
  });
});
