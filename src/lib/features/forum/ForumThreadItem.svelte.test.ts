// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

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
    useRoomScopes: () => ({
      acquire: () => ({ cosmetics: { for: () => null }, pinned, release: vi.fn() }),
    }),
  };
});

import ForumThreadItemHarness from './ForumThreadItemHarness.test.svelte';
import { collectForumThreads, type ForumThread } from './forum-threads';
import ForumThreadList from './ForumThreadListHarness.test.svelte';
import { reactiveToggle } from '#lib/test-support/toggle.svelte.js';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

const root = withRowFields({
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
    msgtype: 'text',
    edited: false,
    jumbo: null,
  },
  in_reply_to: null,
  thread_root: null,
  thread_summary: null,
  reactions: [],
  is_own: true,
  read_by: [],
  read_timestamps: {},
  per_message_profile: null,
  bundled_link_previews: [],
  link_previews_removed: null,
  shared_by: null,
  redacted_on_ban: null,
  mention: 'none',
  forwarded: null,
  forum_title: null,
  shield: null,
});

const thread: ForumThread = {
  id: 'thread-row',
  item: root,
  eventId: '$thread:example.org',
  title: null,
  sender: '@alice:example.org',
  senderName: 'Alice',
  senderAvatar: null,
  isOwn: true,
  editable: true,
  html: null,
  mediaCaption: false,
  createdAt: 0,
  preview: 'Topic body',
  thumbnail: null,
  replyCount: 2,
  lastActivityAt: 0,
  lastBody: null,
  lastSenderName: null,
  unread: false,
  votes: 0,
  ownVote: null,
  resolved: false,
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

test('shows an untitled thread by its body and author', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(ForumThreadItemHarness, {
    thread,
    onOpen,
    canDelete: false,
    onDelete: vi.fn(),
    roomId: '!forum:example.org',
    onCopyLink: vi.fn(),
  });

  expect(within(card()).getByText('Alice')).toBeInTheDocument();
  const topic = within(card()).getByRole('heading', { name: 'Topic body' });
  await user.click(topic);
  expect(onOpen).toHaveBeenCalledWith('$thread:example.org');
});

test('leads a titled thread with its title and previews the body', () => {
  render(ForumThreadItemHarness, {
    thread: { ...thread, title: 'Release plans' },
    onOpen: vi.fn(),
    canDelete: false,
    onDelete: vi.fn(),
    roomId: '!forum:example.org',
    onCopyLink: vi.fn(),
    pinned: true,
  });

  const heading = within(card()).getByRole('heading', { name: /Release plans/ });
  expect(within(heading).getByLabelText('Pinned')).toBeInTheDocument();
  expect(within(card()).getByText(': Topic body')).toBeInTheDocument();
  expect(
    within(card()).getByRole('button', { name: /^Alice: Release plans\. 2 replies, / })
  ).toBeInTheDocument();
});

test('keeps a spoilered thumbnail covered', () => {
  render(ForumThreadItemHarness, {
    thread: {
      ...thread,
      thumbnail: {
        source: 'mxc://example.org/cat',
        thumbnail: null,
        width: 640,
        height: 480,
        blurhash: null,
        video: false,
        spoiler: true,
      },
    },
    onOpen: vi.fn(),
    canDelete: false,
    onDelete: vi.fn(),
    roomId: '!forum:example.org',
    onCopyLink: vi.fn(),
  });

  expect(card().querySelector('.forum-thread-media')).toBeInTheDocument();
  expect(card().querySelector('.forum-thread-image')).not.toBeInTheDocument();
});

test('votes from the thread list without opening the thread', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const onReact = vi.fn();
  const { rerender } = render(ForumThreadItemHarness, {
    thread: { ...thread, votes: 2 },
    onOpen,
    canDelete: false,
    onDelete: vi.fn(),
    roomId: '!forum:example.org',
    onReact,
    onCopyLink: vi.fn(),
  });

  const vote = within(card()).getByRole('button', { name: 'Vote for this thread, 2 votes' });
  expect(vote).toHaveAttribute('aria-pressed', 'false');
  await user.click(vote);
  expect(onReact).toHaveBeenLastCalledWith('$thread:example.org', '👍');

  await rerender({ thread: { ...thread, votes: 3, ownVote: '👍🏽' } });
  const voted = within(card()).getByRole('button', { name: 'Vote for this thread, 3 votes' });
  expect(voted).toHaveAttribute('aria-pressed', 'true');
  await user.click(voted);
  expect(onReact).toHaveBeenLastCalledWith('$thread:example.org', '👍🏽');
  expect(onOpen).not.toHaveBeenCalled();
});

test('shows votes as text to someone who cannot react', () => {
  render(ForumThreadItemHarness, {
    thread: { ...thread, votes: 2 },
    onOpen: vi.fn(),
    canDelete: false,
    onDelete: vi.fn(),
    roomId: '!forum:example.org',
    onCopyLink: vi.fn(),
  });

  expect(within(card()).getByText('👍 2')).toBeInTheDocument();
  expect(within(card()).queryByRole('button', { name: /2 votes/ })).not.toBeInTheDocument();
});

function noopCallbacks() {
  return { onOpen: vi.fn(), onDelete: vi.fn(), onCopyLink: vi.fn() };
}

test.each(['list', 'gallery'] as const)(
  'a deleted pinned post leaves the %s view',
  async (layout) => {
    const { rerender } = render(ForumThreadList, {
      threads: [thread],
      loading: false,
      canLoadMore: false,
      callbacks: noopCallbacks(),
      canDelete: () => false,
      roomId: '!forum:example.org',
      onLoadMore: vi.fn(),
      isPinned: () => true,
      layout,
    });
    expect(screen.getByRole('list', { name: 'Pinned threads' })).toBeVisible();
    const redacted = {
      ...root,
      content: { kind: 'redacted' as const, reason: null, redacted_by: null },
    };
    await rerender({ threads: collectForumThreads([redacted, root], null) });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Pinned threads' })).not.toBeInTheDocument();
    expect(document.querySelector('.forum-thread-list-empty')).not.toBeNull();
  }
);

test('thread actions follow a live change to the host callbacks', async () => {
  const user = userEvent.setup();
  const canPin = reactiveToggle();
  const onPin = () => {};
  render(ForumThreadList, {
    threads: [thread],
    loading: false,
    canLoadMore: false,
    callbacks: {
      ...noopCallbacks(),
      get onPin() {
        return canPin.on ? onPin : undefined;
      },
    },
    canDelete: () => false,
    roomId: '!forum:example.org',
    onLoadMore: vi.fn(),
  });
  const pinItem = async () => {
    await user.pointer({ keys: '[MouseRight]', target: card() });
    const menu = await screen.findByRole('menu');
    const found = within(menu).queryByRole('menuitem', { name: 'Pin message' });
    await user.keyboard('{Escape}');
    await vi.waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(document.body.style.pointerEvents).toBe('');
    });
    return found;
  };

  expect(await pinItem()).not.toBeNull();
  canPin.on = false;
  expect(await pinItem()).toBeNull();
  canPin.on = true;
  expect(await pinItem()).not.toBeNull();
});
