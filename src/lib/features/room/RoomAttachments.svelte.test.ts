// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomAttachmentContentView, RoomAttachmentView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import RoomAttachments from './RoomAttachments.svelte';

const roomAttachments = vi.fn();
Object.assign(core, { roomAttachments });

afterEach(() => {
  document.body.replaceChildren();
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

function render(
  props: {
    onJump?: () => void;
    onOpenMedia?: () => void;
    onMatrixLink?: () => void;
    modal?: boolean;
  } = {}
) {
  return mount(RoomAttachments, {
    target: document.body,
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

function tab(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (button) => button.textContent.trim() === label
  );
  if (!found) throw new Error(`${label} tab missing`);
  return found;
}

test('files are grouped by month, page on demand and open in the viewer', async () => {
  roomAttachments
    .mockResolvedValueOnce({ items: [], exhausted: true })
    .mockResolvedValueOnce({ items: [file('$a', 'notes.pdf')], exhausted: false })
    .mockResolvedValueOnce({ items: [file('$b', 'slides.pdf', FEBRUARY)], exhausted: true });
  const onOpenMedia = vi.fn();
  const instance = render({ onOpenMedia });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledWith('!room:example.org', 'media', 30, 0);
  });

  tab('Files').click();
  flushSync();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.attachment-row')).toHaveLength(1);
  });
  expect(roomAttachments).toHaveBeenLastCalledWith('!room:example.org', 'file', 30, 0);

  document.querySelector<HTMLButtonElement>('.attachments-more button')?.click();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.attachment-row')).toHaveLength(2);
  });
  expect(roomAttachments).toHaveBeenLastCalledWith('!room:example.org', 'file', 30, 30);
  expect(document.querySelectorAll('.group-heading')).toHaveLength(2);
  expect(document.querySelector('.attachments-more')).toBeNull();

  document.querySelectorAll<HTMLButtonElement>('.attachment-row')[1]?.click();
  flushSync();
  expect(onOpenMedia).toHaveBeenCalledWith(
    [
      expect.objectContaining({ eventId: '$a', kind: 'file', filename: 'notes.pdf' }),
      expect.objectContaining({ eventId: '$b', kind: 'file', filename: 'slides.pdf' }),
    ],
    '$b'
  );
  await unmount(instance);
});

test('a page emptied by unreadable events moves on instead of claiming the room is empty', async () => {
  roomAttachments
    .mockResolvedValueOnce({ items: [], exhausted: false })
    .mockResolvedValueOnce({ items: [file('$late', 'late.pdf')], exhausted: true });
  const instance = render();
  tab('Files');
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(2);
  });
  expect(roomAttachments).toHaveBeenLastCalledWith('!room:example.org', 'media', 30, 30);
  expect(document.querySelector('.attachments-status')).toBeNull();
  await unmount(instance);
});

test('the tabs follow the arrow keys and keep one tab stop', async () => {
  roomAttachments.mockResolvedValue({ items: [], exhausted: true });
  const instance = render();
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  const media = tab('Media');
  expect(media.tabIndex).toBe(0);
  expect(tab('Links').tabIndex).toBe(-1);
  expect(media.getAttribute('aria-controls')).toBe('attachments-panel');

  media.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  flushSync();
  expect(tab('Links').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tab('Links'));
  expect(document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
    'attachments-tab-link'
  );
  await unmount(instance);
});

test('links show the host, cap the list and keep a named way back to the message', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], exhausted: true }).mockResolvedValueOnce({
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
    exhausted: true,
  });
  const onJump = vi.fn();
  const instance = render({ onJump });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  tab('Links').click();
  flushSync();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.link')).toHaveLength(3);
  });
  const first = document.querySelector<HTMLAnchorElement>('.link');
  expect(first?.getAttribute('href')).toBe('https://example.org/a');
  expect(first?.getAttribute('rel')).toBe('noopener noreferrer');
  expect(first?.querySelector('.link-host')?.textContent).toBe('example.org');
  expect(document.querySelector('.link-more')?.textContent.trim()).toBe('+1 more link');

  const back = document.querySelector<HTMLButtonElement>('.link-jump');
  expect(back?.getAttribute('aria-label')).toContain('Jump to message');
  back?.click();
  flushSync();
  expect(onJump).toHaveBeenCalledWith('$link');
  await unmount(instance);
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
    exhausted: true,
  });
  const onOpenMedia = vi.fn();
  const instance = render({ onOpenMedia });
  await vi.waitFor(() => {
    expect(document.querySelector('.tile-placeholder')).not.toBeNull();
  });

  expect(document.querySelector('.media-image')).toBeNull();
  const tile = document.querySelector<HTMLButtonElement>('.media-tile');
  expect(tile?.getAttribute('aria-label')).toContain('Spoiler: the ending');

  tile?.click();
  flushSync();
  expect(onOpenMedia).toHaveBeenCalledWith(
    [expect.objectContaining({ eventId: '$secret', spoiler: 'the ending' })],
    '$secret'
  );
  await unmount(instance);
});

test('an empty room says what was searched', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], exhausted: true });
  const instance = render();
  await vi.waitFor(() => {
    expect(document.querySelector('.attachments-status')?.textContent).toBe(
      'No images or videos indexed on this device yet.'
    );
  });
  await unmount(instance);
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
    .mockResolvedValueOnce({ items: [image('$a'), image('$b')], exhausted: false })
    .mockResolvedValueOnce({ items: [image('$b'), image('$c')], exhausted: true });
  const instance = render();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.media-tile')).toHaveLength(2);
  });

  document.querySelector<HTMLButtonElement>('.attachments-more button')?.click();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.media-tile')).toHaveLength(3);
  });
  await unmount(instance);
});

test('each gallery item gets its own tile and opens by its own id', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [
      { ...image('$gallery'), gallery_index: 0 },
      { ...image('$gallery'), gallery_index: 2 },
    ],
    exhausted: true,
  });
  const onOpenMedia = vi.fn();
  const instance = render({ onOpenMedia });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.media-tile')).toHaveLength(2);
  });

  document.querySelectorAll<HTMLButtonElement>('.media-tile')[1]?.click();
  flushSync();

  expect(onOpenMedia).toHaveBeenCalledWith(
    [
      expect.objectContaining({ eventId: '$gallery:gallery:0' }),
      expect.objectContaining({ eventId: '$gallery:gallery:2' }),
    ],
    '$gallery:gallery:2'
  );
  await unmount(instance);
});

test('the grid is one tab stop that the arrow keys move through', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [image('$a'), image('$b'), image('$c'), image('$d')],
    exhausted: true,
  });
  const instance = render();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.media-tile')).toHaveLength(4);
  });

  const tiles = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.media-tile'));
  expect(tiles().map((tile) => tile.tabIndex)).toEqual([0, -1, -1, -1]);

  tiles()[0]?.focus();
  tiles()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  flushSync();
  expect(document.activeElement).toBe(tiles()[3]);
  expect(tiles()[3]?.tabIndex).toBe(0);
  await unmount(instance);
});

test('a matrix.to link routes inside the app instead of opening a tab', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], exhausted: true }).mockResolvedValueOnce({
    items: [
      attachment('$permalink', {
        kind: 'link',
        urls: ['https://matrix.to/#/!other:example.org/$target'],
        body: 'look',
      }),
    ],
    exhausted: true,
  });
  const onMatrixLink = vi.fn();
  const instance = render({ onMatrixLink });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  tab('Links').click();
  flushSync();
  await vi.waitFor(() => {
    expect(document.querySelector('.link')).not.toBeNull();
  });
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  document.querySelector('.link')?.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(true);
  expect(onMatrixLink).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'event', eventId: '$target' }),
    expect.any(HTMLAnchorElement)
  );
  await unmount(instance);
});

test('after five empty pages it waits to be asked again', async () => {
  roomAttachments.mockResolvedValue({ items: [], exhausted: false });
  const instance = render();
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(5);
    expect(document.querySelector('.attachments-more button')).not.toBeNull();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(roomAttachments).toHaveBeenCalledTimes(5);

  document.querySelector<HTMLButtonElement>('.attachments-more button')?.click();
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(10);
  });
  await unmount(instance);
});

test('an audio file opens in the viewer as audio', async () => {
  roomAttachments.mockResolvedValueOnce({ items: [], exhausted: true }).mockResolvedValueOnce({
    items: [
      attachment('$voice', {
        kind: 'file',
        filename: 'memo.ogg',
        source: 'mxc://example.org/memo',
        mime: 'audio/ogg',
        size: null,
      }),
    ],
    exhausted: true,
  });
  const onOpenMedia = vi.fn();
  const instance = render({ onOpenMedia });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  tab('Files').click();
  flushSync();
  await vi.waitFor(() => {
    expect(document.querySelector('.attachment-row')).not.toBeNull();
  });
  document.querySelector<HTMLButtonElement>('.attachment-row')?.click();
  flushSync();
  expect(onOpenMedia).toHaveBeenCalledWith(
    [expect.objectContaining({ kind: 'audio', filename: 'memo.ogg' })],
    '$voice'
  );
  await unmount(instance);
});
