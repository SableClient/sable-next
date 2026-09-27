// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

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

vi.mock('#lib/rooms/bookmarks.svelte.js', () => ({
  useBookmarks: () => ({ has: () => false }),
}));

vi.mock('#lib/features/room/messages/event-items.svelte.js', () => ({
  useEventItems: () => ({ get: () => undefined }),
}));

vi.mock('#lib/features/room/messages/message-scope.svelte.js', async () => {
  const { PinnedEvents } = await vi.importActual<
    typeof import('#lib/features/room/timeline/pinned-events.svelte.js')
  >('#lib/features/room/timeline/pinned-events.svelte.js');
  const pinned = new PinnedEvents({
    pinnedEvents: () => Promise.resolve([]),
    setPinned: () => Promise.resolve([]),
  });
  return {
    useRoomScopes: () => ({ acquire: () => ({ cosmetics: null, pinned, release: vi.fn() }) }),
  };
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
  link_previews_removed: null,
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

const card = () => screen.getAllByRole('article')[0];

test('uses the timeline context menu for a forum thread', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(ForumThreadItemHarness, {
    thread,
    onOpen,
    canDelete: true,
    onEdit,
    onDelete,
    roomId: '!forum:example.org',
    onReact: vi.fn(),
    loadImagePacks: vi.fn(() => Promise.resolve([])),
    onCopyLink: vi.fn(),
  });

  await user.pointer({ keys: '[MouseRight]', target: card() });

  const menu = await screen.findByRole('menu');
  for (const action of ['Reply in thread', 'Edit message', 'Copy message', 'Delete message']) {
    expect(within(menu).getByRole('menuitem', { name: action })).toBeInTheDocument();
  }

  await user.click(within(menu).getByRole('menuitem', { name: 'Edit message' }));
  expect(onEdit).toHaveBeenCalledWith(thread);
  await vi.waitFor(() => {
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).toBe('');
  });

  await user.pointer({ keys: '[MouseRight]', target: card() });
  await user.click(
    within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Delete message' })
  );
  expect(await screen.findByText('Delete thread?')).toBeInTheDocument();
});

test('renders the thread root through the timeline renderer', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(ForumThreadItemHarness, {
    thread,
    onOpen,
    canDelete: false,
    onDelete: vi.fn(),
    roomId: '!forum:example.org',
    loadImagePacks: vi.fn(() => Promise.resolve([])),
    onCopyLink: vi.fn(),
  });

  expect(within(card()).getByText('Alice')).toBeInTheDocument();
  const topic = within(card()).getByText('Topic');
  expect(topic.tagName).toBe('STRONG');
  await user.click(topic);
  expect(onOpen).toHaveBeenCalledWith('$thread:example.org');
});
