// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => ({
  ...(await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  )),
  usePresenceStore: () => ({ get: () => null }),
}));

vi.mock('./bookmarks.svelte.js', () => ({
  useBookmarks: () => ({ has: () => false }),
}));

vi.mock('./event-items.svelte.js', () => ({
  useEventItems: () => ({ get: () => undefined }),
}));

vi.mock('./message-scope.svelte.js', async () => {
  const { PinnedEvents } = await vi.importActual<typeof import('./pinned-events.svelte.js')>(
    './pinned-events.svelte.js'
  );
  const pinned = new PinnedEvents({
    pinnedEvents: () => Promise.resolve([]),
    setPinned: () => Promise.resolve([]),
  });
  return { useRoomScopes: () => ({ for: () => ({ cosmetics: null, pinned }) }) };
});

import { core } from '#lib/core/__mocks__/context.js';

import ThreadList from './ThreadList.svelte';

const listThreads = vi.fn();
Object.assign(core, { listThreads });

afterEach(() => {
  document.body.replaceChildren();
  listThreads.mockReset();
});

function root(id: string, body: string): TimelineItemView {
  return {
    id,
    event_id: id,
    transaction_id: null,
    send_state: null,
    sender: '@ana:example.org',
    sender_name: 'Ana',
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'message', body, html: body, emote: false, notice: false, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    bundled_link_previews: [],
    mention: 'none',
    forwarded: null,
  };
}

test('lists thread roots page by page and opens the one picked', async () => {
  listThreads
    .mockResolvedValueOnce({ roots: [root('$a', 'First topic')], next_batch: 'next' })
    .mockResolvedValueOnce({ roots: [root('$b', 'Second topic')], next_batch: null });
  const onOpenThread = vi.fn();
  const instance = mount(ThreadList, {
    target: document.body,
    props: { roomId: '!room:example.org', members: [], onOpenThread, onClose: vi.fn() },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.thread-root')).toHaveLength(1);
  });
  expect(document.querySelector('.thread-root .sender')?.textContent).toContain('Ana');
  expect(document.querySelector('.thread-root .formatted-body')?.textContent).toContain(
    'First topic'
  );

  document.querySelector<HTMLButtonElement>('.thread-list-more button')?.click();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.thread-root')).toHaveLength(2);
  });
  expect(listThreads).toHaveBeenLastCalledWith('!room:example.org', 'next');
  expect(document.querySelector('.thread-list-more')).toBeNull();

  document.querySelectorAll<HTMLElement>('.thread-root .formatted-body')[1]?.click();
  flushSync();
  expect(onOpenThread).toHaveBeenCalledWith('$b');
  await unmount(instance);
});

test('says so when a room has no threads', async () => {
  listThreads.mockResolvedValueOnce({ roots: [], next_batch: null });
  const instance = mount(ThreadList, {
    target: document.body,
    props: { roomId: '!room:example.org', members: [], onOpenThread: vi.fn(), onClose: vi.fn() },
  });
  await tick();
  await vi.waitFor(() => {
    expect(document.querySelector('.thread-list-status')).not.toBeNull();
  });
  await unmount(instance);
});
