// @vitest-environment happy-dom

import { screen } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.ts';

import RoomMediaAttachments from './RoomMediaAttachments.svelte';
import { attachment, image } from './attachment-fixtures';

const roomAttachments = vi.fn();
Object.assign(core.rpc.rooms, { attachments: roomAttachments });

afterEach(() => {
  roomAttachments.mockReset();
});

const user = userEvent.setup();

function setup(props: { onJump?: () => void } = {}) {
  return renderWithTooltips(RoomMediaAttachments, {
    props: {
      roomId: '!room:example.org',
      members: [],
      onJump: props.onJump ?? vi.fn(),
    },
  });
}

function request(from: string | null) {
  return { room_id: '!room:example.org', kind: 'media', limit: 30, from };
}

const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('.media-tile')];

test('a spoilered picture is never loaded and says why it is hidden', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [image('$secret', 'the ending')],
    next_batch: null,
  });
  const openPanelSpy = vi.spyOn(mediaViewerState, 'openPanel');
  setup();
  const tile = await screen.findByRole('button', { name: /Spoiler: the ending/ });

  expect(roomAttachments).toHaveBeenCalledWith(request(null));
  expect(tile.querySelector('.tile-placeholder')).toBeInTheDocument();
  expect(document.querySelector('.media-image')).not.toBeInTheDocument();

  await user.click(tile);
  expect(openPanelSpy).toHaveBeenCalledWith(
    [expect.objectContaining({ eventId: '$secret', spoiler: 'the ending' })],
    '$secret',
    expect.any(Function)
  );
});

test('an empty room says what was searched', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], next_batch: null });
  setup();
  expect(
    await screen.findByText('No images or videos indexed on this device yet.')
  ).toBeInTheDocument();
});

test('an item of another kind is left out of the grid', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [
      image('$a'),
      attachment('$doc', {
        kind: 'file',
        filename: 'doc.pdf',
        source: 'mxc://example.org/doc',
        mime: 'application/pdf',
        size: null,
      }),
    ],
    next_batch: null,
  });
  setup();
  await vi.waitFor(() => {
    expect(tiles()).toHaveLength(1);
  });
});

test('an item the next page repeats is shown once', async () => {
  roomAttachments
    .mockResolvedValueOnce({ items: [image('$a'), image('$b')], next_batch: 'next' })
    .mockResolvedValueOnce({ items: [image('$b'), image('$c')], next_batch: null });
  setup();
  await vi.waitFor(() => {
    expect(tiles()).toHaveLength(2);
  });

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await vi.waitFor(() => {
    expect(tiles()).toHaveLength(3);
  });
  expect(roomAttachments).toHaveBeenLastCalledWith(request('next'));
});

test('each gallery item gets its own tile and opens by its own id', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [
      { ...image('$gallery'), gallery_index: 0 },
      { ...image('$gallery'), gallery_index: 2 },
    ],
    next_batch: null,
  });
  const openPanelSpy = vi.spyOn(mediaViewerState, 'openPanel');
  setup();
  await vi.waitFor(() => {
    expect(tiles()).toHaveLength(2);
  });

  await user.click(tiles()[1]);

  expect(openPanelSpy).toHaveBeenCalledWith(
    [
      expect.objectContaining({ eventId: '$gallery:gallery:0' }),
      expect.objectContaining({ eventId: '$gallery:gallery:2' }),
    ],
    '$gallery:gallery:2',
    expect.any(Function)
  );
});

test('the grid is one tab stop that the arrow keys move through', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [image('$a'), image('$b'), image('$c'), image('$d')],
    next_batch: null,
  });
  setup();
  await vi.waitFor(() => {
    expect(tiles()).toHaveLength(4);
  });

  expect(tiles().map((tile) => tile.tabIndex)).toEqual([0, -1, -1, -1]);

  tiles()[0].focus();
  await user.keyboard('{ArrowDown}');
  expect(tiles()[3]).toHaveFocus();
  expect(tiles()[3]).toHaveAttribute('tabindex', '0');
  await user.keyboard('{ArrowLeft}');
  expect(tiles()[2]).toHaveFocus();
});
