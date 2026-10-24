// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

const { saveBytes } = vi.hoisted(() => ({
  saveBytes: vi.fn(() => Promise.resolve('saved' as const)),
}));

vi.mock('#lib/platform/files.js', async () => ({
  ...(await vi.importActual<typeof import('#lib/platform/files.js')>('#lib/platform/files.js')),
  saveBytes,
}));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { LONG_PRESS_MS } from '#lib/ui/long-press.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import {
  core,
  user,
  press,
  openMenu,
  hover,
  menuItem,
  menuLabels,
  resetTimelineItemTest,
  item,
  imageItem,
  fileItem,
} from './timeline-item-fixtures';
import { withRowFields } from './row-fixtures.js';

afterEach(resetTimelineItemTest);

test('an open message dialog outlives its row leaving the window', async () => {
  const props = $state({
    core,
    item: { item: item(false), collapsed: false },
    readers: ['@bob:example.org'],
    showItem: true,
  });
  render(TimelineItemHarness, { props });
  await tick();

  await openMenu(document.querySelector('.message'));
  await tick();
  await user.click(menuItem('Read receipts'));
  const dialog = await screen.findByRole('dialog');

  props.showItem = false;
  await tick();

  expect(document.querySelector('.message')).not.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
});

test.each([
  [true, true],
  [false, false],
])('offers pinning when canPin is %s', async (canPin, offered) => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, roomId: '!room:example.org', canPin },
    },
  });
  await tick();

  await openMenu(document.querySelector('.message'));
  await tick();

  const labels = menuLabels();
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.some((label) => label.includes('Pin message'))).toBe(offered);
});

test('edits an own image caption without dropping its media details', async () => {
  const onEdit = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array());
  const image = withRowFields({
    ...imageItem(),
    is_own: true,
    content: { ...imageItem().content, caption: 'caption' },
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: image, collapsed: false, onEdit } },
  });
  await tick();

  await hover(document.querySelector('.message'));
  await tick();
  const edit = screen.getByRole('button', { name: 'Edit message' });
  const hitTest = vi.spyOn(document, 'elementFromPoint').mockReturnValue(edit);
  try {
    await press(edit);
  } finally {
    hitTest.mockRestore();
  }

  expect(onEdit).toHaveBeenCalledWith('$item', 'caption', null, true);
});

test('edits an own file caption without dropping its attachment', async () => {
  const onEdit = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array());
  const file = withRowFields({
    ...fileItem(),
    is_own: true,
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: file, collapsed: false, onEdit } },
  });
  await tick();

  await hover(document.querySelector('.message'));
  await tick();
  const edit = screen.getByRole('button', { name: 'Edit message' });
  const hitTest = vi.spyOn(document, 'elementFromPoint').mockReturnValue(edit);
  try {
    await press(edit);
  } finally {
    hitTest.mockRestore();
  }

  expect(onEdit).toHaveBeenCalledWith('$item', 'the code', null, true);
});

test('a file from someone else cannot be edited', async () => {
  const onEdit = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array());
  render(TimelineItemHarness, {
    props: { core, item: { item: fileItem(), collapsed: false, onEdit } },
  });
  await tick();

  await hover(document.querySelector('.message'));
  await tick();

  expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
});

test('does not mount hidden message dialogs', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(document.querySelector('.delete')).toBeNull();
  expect(document.querySelector('.member-list-dialog')).toBeNull();
  expect(document.querySelector('.receipts-dialog')).toBeNull();
});

test('opens an image from a mobile pointer interaction', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onOpenMedia = vi.fn();
  render(TimelineItemHarness, {
    props: { core, item: { item: imageItem(), collapsed: false, onOpenMedia } },
  });
  await tick();
  const image = document.querySelector<HTMLButtonElement>('.media-image-activation');
  if (!image) throw new Error('media trigger was not rendered');

  image.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true })
  );
  image.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', isPrimary: true })
  );
  await press(image);

  expect(onOpenMedia).toHaveBeenCalledWith('$item');
});

test('provides a formatted reaction attribution tooltip', async () => {
  const reacted = {
    ...item(false),
    reactions: [{ key: '👍', senders: ['@alice:example.org'] }],
  };
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: reacted,
        collapsed: false,
        members: [
          {
            user_id: '@alice:example.org',
            display_name: 'Alice',
            avatar_url: null,
            power_level: 0,
            membership: 'join',
            member_ts: null,
            kicked: false,
            service: false,
          },
        ],
      },
    },
  });
  await tick();

  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');
  vi.useFakeTimers();
  await hover(reaction);
  await vi.advanceTimersByTimeAsync(400);
  await tick();

  expect(document.querySelector('.tooltip')?.textContent).toBe('👍 Alice reacted with :thumbsup:');
  vi.useRealTimers();
});

test('keeps a long text reaction separate from its count', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: {
          ...item(false),
          reactions: [
            {
              key: 'this is an absurdly long reaction to test the reaction layout',
              senders: ['@alice:example.org'],
            },
          ],
        },
        collapsed: false,
      },
    },
  });
  await tick();

  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  expect(reaction?.querySelector('.reaction-key')?.textContent).toBe(
    'this is an absurdly long reaction to test the reaction layout'
  );
  expect(reaction?.querySelector('.reaction-count')?.textContent).toBe('1');
});

test('mounts the action bar on hover and keeps it while its menu is open', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, onReply: vi.fn(), onCopyLink: vi.fn() },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');
  expect(document.querySelector('.message-actions')).toBeNull();

  await hover(message);
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();

  await press(document.querySelector('.message-actions [data-dropdown-menu-trigger]'));
  await fireEvent.pointerLeave(message, { pointerType: 'mouse' });
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();
});

test('opens message actions on right click', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, onReply: vi.fn(), onCopyLink: vi.fn() },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();

  expect(menuLabels()).toContain('Reply');
  expect(menuLabels()).toContain('Copy link to message');
});

test('picking a quick reaction from the context menu closes it', async () => {
  const onToggleReaction = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, onReply: vi.fn(), onToggleReaction },
    },
  });
  await tick();

  await openMenu(document.querySelector('article.message'));
  await tick();
  await press(document.querySelector('[data-context-menu-content] .quick-reaction'));

  expect(onToggleReaction).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('[data-context-menu-content]')).toHaveLength(0);
});

test('copies a message link when it is right-clicked', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const linked = item(false);
  if (linked.content.kind !== 'message') throw new Error('expected a message');
  linked.content.html = '<a href="https://example.org">Link</a>';
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: linked,
        collapsed: false,
        onReply: vi.fn(),
      },
    },
  });
  await tick();

  await openMenu(screen.getByRole('link', { name: 'Link' }));
  await press(menuItem('Copy link'));

  expect(writeText).toHaveBeenCalledWith('https://example.org/');
});

test('downloads an image from its message menu, with progress on the message', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const listeners: ((event: CoreEvent) => void)[] = [];
  const subscribe = vi.mocked(
    core.subscribeEvents as unknown as (onEvent: (event: CoreEvent) => void) => () => void
  );
  subscribe.mockImplementation((onEvent) => {
    listeners.push(onEvent);
    return () => {};
  });
  let finish: (value: Uint8Array<ArrayBuffer>) => void = () => {};
  const original = new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
    finish = resolve;
  });
  const fetchMedia = vi.mocked(
    core.fetchMedia as unknown as (
      source: string,
      width: number,
      height: number
    ) => Promise<Uint8Array<ArrayBuffer>>
  );
  fetchMedia.mockImplementation((_source, width) =>
    width === 0 ? original : new Promise(() => {})
  );
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: imageItem(), collapsed: false, onReply: vi.fn() } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();
  await user.click(screen.getByRole('menuitem', { name: 'Download' }));
  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/photo', 0, 0);
  });
  await tick();

  for (const listener of listeners) {
    listener({ type: 'media_progress', source: 'mxc://example.org/photo', current: 3, total: 4 });
  }
  await tick();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');

  finish(bytes);
  await vi.waitFor(() => {
    expect(saveBytes).toHaveBeenCalledWith(bytes, 'photo.png', 'image/png', true);
  });
  expect(screen.queryByRole('progressbar')).toBeNull();
  instance.unmount();
  subscribe.mockImplementation(() => () => {});
  fetchMedia.mockImplementation(() => new Promise(() => {}));
});

test('offers no download for a text message', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();

  expect(menuLabels()).toContain('Reply');
  expect(menuLabels()).not.toContain('Download');
});

test('long pressing a reaction opens its people list without toggling it', async () => {
  vi.useFakeTimers();
  const onToggleReaction = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: { ...item(false), reactions: [{ key: '👍', senders: ['@alice:example.org'] }] },
        collapsed: false,
        onToggleReaction,
        members: [
          {
            user_id: '@alice:example.org',
            display_name: 'Alice',
            avatar_url: null,
            power_level: 0,
            membership: 'join',
            member_ts: null,
            kicked: false,
            service: false,
          },
        ],
      },
    },
  });
  await tick();
  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');

  await fireEvent.pointerDown(reaction, { pointerType: 'touch', isPrimary: true });
  await vi.advanceTimersByTimeAsync(LONG_PRESS_MS);
  await tick();
  await fireEvent.click(reaction);

  expect(await screen.findByRole('dialog')).toHaveTextContent('Alice');
  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(onToggleReaction).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('a touch long press opens the sheet without also opening the context menu', async () => {
  vi.useFakeTimers();
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  const article = document.querySelector('article.message');
  expect(article).not.toBeNull();

  article?.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      clientX: 0,
      clientY: 0,
    })
  );
  await vi.advanceTimersByTimeAsync(1000);
  await tick();

  const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  article?.dispatchEvent(native);
  await tick();

  expect(native.defaultPrevented).toBe(true);
  expect(document.querySelectorAll('[data-context-menu-content]')).toHaveLength(0);
  expect(document.querySelector('[data-dialog-content]')).not.toBeNull();

  instance.unmount();
  vi.useRealTimers();
});

test('a touch context menu the row never saw pressed opens the sheet', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  const native = new PointerEvent('contextmenu', {
    pointerType: 'touch',
    bubbles: true,
    cancelable: true,
  });
  document.querySelector('article.message')?.dispatchEvent(native);
  await tick();

  expect(native.defaultPrevented).toBe(true);
  expect(document.querySelectorAll('[data-context-menu-content]')).toHaveLength(0);
  expect(document.querySelector('[data-dialog-content]')).not.toBeNull();
});

test('offers to add a message inline emote to your own pack', async () => {
  // The SDK sanitises `data-mx-emoticon` away before the core sees the message.
  const html =
    '<img src="mxc://sable.moe/As8m" alt=":neocat_amogus:" title=":neocat_amogus:" height="32"> ';
  const emoteItem = withRowFields({
    ...item(false),
    content: {
      kind: 'message' as const,
      body: ':neocat_amogus:',
      html,
      emote: false,
      notice: false,
      edited: false,
    },
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: emoteItem, collapsed: false, onReply: vi.fn() } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();

  expect(menuLabels()).toContain('Add emote to my pack');
});

async function swipeLeft(message: Element, distance = 400): Promise<void> {
  const touch = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: type === 'touchend' ? [] : [{ clientX: x, clientY: 0 }],
    });
    message.dispatchEvent(event);
  };
  touch('touchstart', 0);
  touch('touchmove', -distance);
  touch('touchend', 0);
  await tick();
}

test('a swipe on a message that is not the reply target replies to it', async () => {
  const onReply = vi.fn();
  const onCancelContext = vi.fn();
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, onReply, onCancelContext } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await swipeLeft(message);

  expect(onReply).toHaveBeenCalledOnce();
  expect(onCancelContext).not.toHaveBeenCalled();
});

test('a swipe on the message being replied to cancels the reply', async () => {
  const onReply = vi.fn();
  const onCancelContext = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, selected: true, onReply, onCancelContext },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await swipeLeft(message);

  expect(onCancelContext).toHaveBeenCalledOnce();
  expect(onReply).not.toHaveBeenCalled();
});

test('a long swipe on the message being edited cancels the edit', async () => {
  const onEdit = vi.fn();
  const onCancelContext = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: { ...item(false), is_own: true },
        collapsed: false,
        editing: true,
        onReply: vi.fn(),
        onEdit,
        onCancelContext,
      },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await swipeLeft(message, 3000);

  expect(onCancelContext).toHaveBeenCalledOnce();
  expect(onEdit).not.toHaveBeenCalled();
});

test('a long swipe on a message that is not being edited edits it', async () => {
  const onEdit = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: { ...item(false), is_own: true }, collapsed: false, onReply: vi.fn(), onEdit },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await swipeLeft(message, 3000);

  expect(onEdit).toHaveBeenCalledOnce();
});
