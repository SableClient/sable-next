// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomAttachmentContentView, RoomAttachmentView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import RoomAttachments from './RoomAttachments.svelte';

const roomAttachments = vi.fn();
Object.assign(core, { roomAttachments });

afterEach(() => {
  roomAttachments.mockReset();
});

const MARCH = new Date(2024, 2, 12).getTime();
const FEBRUARY = new Date(2024, 1, 3).getTime();

function attachment(
  eventId: string,
  content: RoomAttachmentContentView,
  timestamp = MARCH
): RoomAttachmentView {
  return { event_id: eventId, gallery_index: null, sender: '@ana:example.org', timestamp, content };
}

function file(eventId: string, filename: string, timestamp = MARCH): RoomAttachmentView {
  return attachment(
    eventId,
    {
      kind: 'file',
      filename,
      source: 'mxc://example.org/file',
      mime: 'application/pdf',
      size: 2_048,
    },
    timestamp
  );
}

function setup(
  props: {
    onJump?: () => void;
    onOpenMedia?: () => void;
    onMatrixLink?: () => void;
    modal?: boolean;
  } = {}
) {
  return render(RoomAttachments, {
    props: {
      roomId: '!room:example.org',
      members: [],
      modal: props.modal ?? false,
      onJump: props.onJump ?? vi.fn(),
      onOpenMedia: props.onOpenMedia ?? vi.fn(),
      onMatrixLink: props.onMatrixLink ?? vi.fn(),
      onClose: vi.fn(),
    },
  });
}

const user = userEvent.setup();
const tab = (name: string) => screen.getByRole('tab', { name });
const openItem = (name: RegExp) => screen.getByRole('button', { name });
const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('.media-tile')];

test('files are grouped by month, page on demand and open in the viewer', async () => {
  roomAttachments
    .mockResolvedValueOnce({ items: [], next_batch: null })
    .mockResolvedValueOnce({ items: [file('$a', 'notes.pdf')], next_batch: 'next' })
    .mockResolvedValueOnce({ items: [file('$b', 'slides.pdf', FEBRUARY)], next_batch: null });
  const onOpenMedia = vi.fn();
  setup({ onOpenMedia });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledWith('!room:example.org', 'media', 30, null);
  });

  await user.click(tab('Files'));
  expect(await screen.findByRole('button', { name: /notes\.pdf/ })).toBeInTheDocument();
  expect(roomAttachments).toHaveBeenLastCalledWith('!room:example.org', 'file', 30, null);

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('button', { name: /slides\.pdf/ })).toBeInTheDocument();
  expect(roomAttachments).toHaveBeenLastCalledWith('!room:example.org', 'file', 30, 'next');
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

  await user.click(openItem(/slides\.pdf/));
  expect(onOpenMedia).toHaveBeenCalledWith(
    [
      expect.objectContaining({ eventId: '$a', kind: 'file', filename: 'notes.pdf' }),
      expect.objectContaining({ eventId: '$b', kind: 'file', filename: 'slides.pdf' }),
    ],
    '$b'
  );
});

test('the tabs follow the arrow keys and keep one tab stop', async () => {
  roomAttachments.mockResolvedValue({ items: [], next_batch: null });
  setup();
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  const media = tab('Media');
  expect(media).toHaveAttribute('tabindex', '0');
  expect(tab('Links')).toHaveAttribute('tabindex', '-1');
  expect(media).toHaveAttribute('aria-controls', 'attachments-panel');

  media.focus();
  await user.keyboard('{ArrowLeft}');
  expect(tab('Links')).toHaveAttribute('aria-selected', 'true');
  expect(tab('Links')).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: 'Links' })).toBeInTheDocument();
});

test('links show the host, cap the list and keep a named way back to the message', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], next_batch: null }).mockResolvedValueOnce({
    items: [
      attachment('$link', {
        kind: 'link',
        urls: [
          'https://example.org/a',
          'https://example.org/b',
          'https://example.org/c',
          'https://example.org/d',
        ],
        body: 'lots of links',
      }),
    ],
    next_batch: null,
  });
  const onJump = vi.fn();
  setup({ onJump });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  await user.click(tab('Links'));
  await vi.waitFor(() => {
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
  const [first] = screen.getAllByRole('link');
  expect(first).toHaveAttribute('href', 'https://example.org/a');
  expect(first).toHaveAttribute('rel', 'noopener noreferrer');
  expect(first.querySelector('.link-host')).toHaveTextContent('example.org');
  expect(screen.getByText('+1 more link')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /Jump to message/ }));
  expect(onJump).toHaveBeenCalledWith('$link');
});

test('a spoilered picture is never loaded and says why it is hidden', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [
      attachment('$secret', {
        kind: 'image',
        filename: 'ending.png',
        source: 'mxc://example.org/ending',
        mime: 'image/png',
        width: 100,
        height: 100,
        blurhash: null,
        thumbnail: null,
        spoiler: 'the ending',
      }),
    ],
    next_batch: null,
  });
  const onOpenMedia = vi.fn();
  setup({ onOpenMedia });
  const tile = await screen.findByRole('button', { name: /Spoiler: the ending/ });

  expect(tile.querySelector('.tile-placeholder')).toBeInTheDocument();
  expect(document.querySelector('.media-image')).not.toBeInTheDocument();

  await user.click(tile);
  expect(onOpenMedia).toHaveBeenCalledWith(
    [expect.objectContaining({ eventId: '$secret', spoiler: 'the ending' })],
    '$secret'
  );
});

test('an empty room says what was searched', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], next_batch: null });
  setup();
  expect(
    await screen.findByText('No images or videos indexed on this device yet.')
  ).toBeInTheDocument();
});

function image(eventId: string): RoomAttachmentView {
  return attachment(eventId, {
    kind: 'image',
    filename: `${eventId}.png`,
    source: `mxc://example.org/${eventId}`,
    mime: 'image/png',
    width: 10,
    height: 10,
    blurhash: null,
    thumbnail: null,
    spoiler: '',
  });
}

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
});

test('each gallery item gets its own tile and opens by its own id', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [
      { ...image('$gallery'), gallery_index: 0 },
      { ...image('$gallery'), gallery_index: 2 },
    ],
    next_batch: null,
  });
  const onOpenMedia = vi.fn();
  setup({ onOpenMedia });
  await vi.waitFor(() => {
    expect(tiles()).toHaveLength(2);
  });

  await user.click(tiles()[1]);

  expect(onOpenMedia).toHaveBeenCalledWith(
    [
      expect.objectContaining({ eventId: '$gallery:gallery:0' }),
      expect.objectContaining({ eventId: '$gallery:gallery:2' }),
    ],
    '$gallery:gallery:2'
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
});

test('a matrix.to link routes inside the app instead of opening a tab', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], next_batch: null }).mockResolvedValueOnce({
    items: [
      attachment('$permalink', {
        kind: 'link',
        urls: ['https://matrix.to/#/!other:example.org/$target'],
        body: 'look',
      }),
    ],
    next_batch: null,
  });
  const onMatrixLink = vi.fn();
  setup({ onMatrixLink });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  await user.click(tab('Links'));
  const link = await screen.findByRole('link');

  expect(await fireEvent.click(link)).toBe(false);
  expect(onMatrixLink).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'event', eventId: '$target' }),
    expect.any(HTMLAnchorElement)
  );
});

test('an audio file opens in the viewer as audio', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], next_batch: null }).mockResolvedValueOnce({
    items: [
      attachment('$voice', {
        kind: 'file',
        filename: 'memo.ogg',
        source: 'mxc://example.org/memo',
        mime: 'audio/ogg',
        size: null,
      }),
    ],
    next_batch: null,
  });
  const onOpenMedia = vi.fn();
  setup({ onOpenMedia });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  await user.click(tab('Files'));
  await user.click(await screen.findByRole('button', { name: /memo\.ogg/ }));
  expect(onOpenMedia).toHaveBeenCalledWith(
    [expect.objectContaining({ kind: 'audio', filename: 'memo.ogg' })],
    '$voice'
  );
});
