// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/TimelineItemView';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
}));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import TimelineItem from './TimelineItem.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function item(emote: boolean): TimelineItemView {
  return {
    id: 'item',
    event_id: '$item',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'message', body: 'waves', html: 'waves', emote, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    mention: 'none',
  };
}

function imageItem(): TimelineItemView {
  return {
    ...item(false),
    content: {
      kind: 'image',
      body: 'photo.png',
      source: 'mxc://example.org/photo',
      mime: 'image/png',
      width: 800,
      height: 600,
    },
  };
}

test('reads an emote as one sentence, with the name only in the action', async () => {
  const instance = mount(TimelineItem, {
    target: document.body,
    props: { item: item(true), collapsed: false },
  });
  await tick();

  expect(document.querySelector('.emote')?.textContent.trim()).toBe('* Alice waves');
  expect(document.querySelector('header .sender')).toBeNull();
  expect(document.querySelector('header time')).not.toBeNull();
  await unmount(instance);
});

test('keeps the sender header for an ordinary message', async () => {
  const instance = mount(TimelineItem, {
    target: document.body,
    props: { item: item(false), collapsed: false },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent).toBe('Alice');
  expect(document.querySelector('.emote')).toBeNull();
  await unmount(instance);
});

test('does not mount hidden message dialogs', async () => {
  const instance = mount(TimelineItem, {
    target: document.body,
    props: { item: item(false), collapsed: false },
  });
  await tick();

  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(document.querySelector('.delete')).toBeNull();
  expect(document.querySelector('.reactions-dialog')).toBeNull();
  expect(document.querySelector('.receipts-dialog')).toBeNull();
  await unmount(instance);
});

test('opens an image from a mobile pointer interaction', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onOpenMedia = vi.fn();
  const instance = mount(TimelineItem, {
    target: document.body,
    props: { item: imageItem(), collapsed: false, onOpenMedia },
  });
  await tick();
  const image = document.querySelector<HTMLButtonElement>('.media-image');
  if (!image) throw new Error('media trigger was not rendered');

  image.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  image.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
  image.click();

  expect(onOpenMedia).toHaveBeenCalledWith('$item');
  await unmount(instance);
});

test('a per-message profile takes the sender position and names the account behind it', async () => {
  const persona = {
    ...item(false),
    per_message_profile: {
      id: 'kris',
      display_name: 'Kris',
      avatar_url: null,
      pronouns: [{ summary: 'they/them', language: null }],
      color_on_light: '#4f7a3a',
      color_on_dark: '#9fd07c',
      has_fallback: false,
    },
  };
  const instance = mount(TimelineItem, {
    target: document.body,
    props: { item: persona, collapsed: false },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent.trim()).toBe('Kris');
  expect(document.querySelector('header .pronouns')?.textContent).toBe('they/them');
  expect(document.querySelector('header .via')?.textContent).toContain('@alice:example.org');
  await unmount(instance);
});

test('provides a formatted reaction attribution tooltip', async () => {
  const reacted = {
    ...item(false),
    reactions: [{ key: '👍', senders: ['@alice:example.org'] }],
  };
  const instance = mount(TimelineItem, {
    target: document.body,
    props: {
      item: reacted,
      collapsed: false,
      members: [
        {
          user_id: '@alice:example.org',
          display_name: 'Alice',
          avatar_url: null,
          power_level: 0,
        },
      ],
    },
  });
  await tick();

  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');
  vi.useFakeTimers();
  reaction.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
  await vi.advanceTimersByTimeAsync(400);
  await tick();

  expect(document.querySelector('.reaction-tooltip')?.textContent).toBe('Alice reacted with 👍');
  vi.useRealTimers();
  await unmount(instance);
});

test('opens message actions on right click', async () => {
  const instance = mount(TimelineItem, {
    target: document.body,
    props: { item: item(false), collapsed: false, onReply: vi.fn() },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  message.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();

  expect(document.querySelector('.message-menu')?.textContent).toContain('Reply');
  await unmount(instance);
});

test('long pressing a reaction opens its people list without toggling it', async () => {
  vi.useFakeTimers();
  const onToggleReaction = vi.fn();
  const instance = mount(TimelineItem, {
    target: document.body,
    props: {
      item: { ...item(false), reactions: [{ key: '👍', senders: ['@alice:example.org'] }] },
      collapsed: false,
      onToggleReaction,
      members: [
        {
          user_id: '@alice:example.org',
          display_name: 'Alice',
          avatar_url: null,
          power_level: 0,
        },
      ],
    },
  });
  await tick();
  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');

  reaction.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  await vi.advanceTimersByTimeAsync(450);
  await tick();
  reaction.click();

  expect(document.querySelector('.reactions-dialog')?.textContent).toContain('Alice');
  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(onToggleReaction).not.toHaveBeenCalled();
  vi.useRealTimers();
  await unmount(instance);
});
