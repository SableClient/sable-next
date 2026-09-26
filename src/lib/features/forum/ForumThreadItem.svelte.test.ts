// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
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

vi.mock('#lib/features/room/bookmarks.svelte.js', () => ({
  useBookmarks: () => ({ has: () => false }),
}));

vi.mock('#lib/features/room/event-items.svelte.js', () => ({
  useEventItems: () => ({ get: () => undefined }),
}));

vi.mock('#lib/features/room/message-scope.svelte.js', async () => {
  const { PinnedEvents } = await vi.importActual<
    typeof import('#lib/features/room/pinned-events.svelte.js')
  >('#lib/features/room/pinned-events.svelte.js');
  const pinned = new PinnedEvents({
    pinnedEvents: () => Promise.resolve([]),
    setPinned: () => Promise.resolve([]),
  });
  return { useRoomScopes: () => ({ for: () => ({ cosmetics: null, pinned }) }) };
});

import ForumThreadItemHarness from './ForumThreadItemHarness.test.svelte';
import type { ForumThread } from './forum-threads';

const root: TimelineItemView = {
  id: 'thread-row',
  event_id: '$thread:example.org',
  transaction_id: null,
  send_state: null,
  sender: '@alice:example.org',
  sender_name: 'Alice',
  sender_avatar: null,
  timestamp: 0,
  content: {
    kind: 'message',
    body: 'Topic body',
    html: '<strong>Topic</strong> body',
    emote: false,
    notice: false,
    edited: false,
  },
  in_reply_to: null,
  thread_root: null,
  thread_summary: null,
  reactions: [],
  is_own: true,
  read_by: [],
  per_message_profile: null,
  bundled_link_previews: [],
  mention: 'none',
  forwarded: null,
};

const thread: ForumThread = {
  id: 'thread-row',
  item: root,
  eventId: '$thread:example.org',
  sender: '@alice:example.org',
  senderName: 'Alice',
  senderAvatar: null,
  isOwn: true,
  editable: true,
  html: null,
  mediaCaption: false,
  createdAt: 0,
  preview: 'Topic body',
  replyCount: 2,
  lastActivityAt: 0,
  lastBody: null,
  lastSenderName: null,
  unread: false,
};

afterEach(() => {
  document.body.replaceChildren();
});

test('uses the timeline context menu for a forum thread', async () => {
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const item = mount(ForumThreadItemHarness, {
    target: document.body,
    props: {
      thread,
      onOpen,
      canDelete: true,
      onEdit,
      onDelete,
      roomId: '!forum:example.org',
      onReact: vi.fn(),
      loadImagePacks: vi.fn(() => Promise.resolve([])),
      onCopyLink: vi.fn(),
    },
  });
  await tick();

  const card = document.querySelector('.forum-thread-card');
  if (!card) throw new Error('forum thread card was not rendered');
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();

  const context = document.querySelector<HTMLElement>('.message-menu');
  if (!context) throw new Error('timeline context menu was not rendered');
  expect(context.textContent).toContain('Reply in thread');
  expect(context.textContent).toContain('Edit message');
  expect(context.textContent).toContain('Copy message');
  expect(context.textContent).toContain('Delete message');

  const edit = [...context.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent.trim() === 'Edit message'
  );
  if (!edit) throw new Error('edit action was not rendered');
  edit.click();
  expect(onEdit).toHaveBeenCalledWith(thread);

  const remove = [...context.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent.trim() === 'Delete message'
  );
  if (!remove) throw new Error('delete action was not rendered');
  remove.click();
  await tick();
  expect(document.body.textContent).toContain('Delete thread?');

  await unmount(item);
});

test('renders the thread root through the timeline renderer', async () => {
  const onOpen = vi.fn();
  const item = mount(ForumThreadItemHarness, {
    target: document.body,
    props: {
      thread,
      onOpen,
      canDelete: false,
      onDelete: vi.fn(),
      roomId: '!forum:example.org',
      loadImagePacks: vi.fn(() => Promise.resolve([])),
      onCopyLink: vi.fn(),
    },
  });
  await tick();

  expect(document.querySelector('.forum-thread-card .sender')?.textContent).toContain('Alice');
  const body = document.querySelector<HTMLElement>('.forum-thread-card .formatted-body');
  expect(body?.querySelector('strong')?.textContent).toBe('Topic');
  body?.click();
  expect(onOpen).toHaveBeenCalledWith('$thread:example.org');

  await unmount(item);
});
