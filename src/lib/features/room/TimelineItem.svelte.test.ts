// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
}));

vi.mock('$lib/core/context', () => ({
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
