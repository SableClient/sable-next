// @vitest-environment happy-dom

import { screen, within } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { userEvent } from '@testing-library/user-event';
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

vi.mock('#lib/rooms/bookmarks.svelte.js', () => ({
  useBookmarks: () => ({ has: () => false }),
}));

vi.mock('../messages/event-items.svelte.js', () => ({
  useEventItems: () => ({ get: () => undefined }),
}));

vi.mock('../messages/message-scope.svelte.js', async () => {
  const { PinnedEvents } = await vi.importActual<
    typeof import('../timeline/pinned-events.svelte.js')
  >('../timeline/pinned-events.svelte.js');
  const pinned = new PinnedEvents({
    pinnedEvents: () => Promise.resolve([]),
    setPinned: () => Promise.resolve([]),
  });
  return {
    useRoomScopes: () => ({ acquire: () => ({ cosmetics: null, pinned, release: vi.fn() }) }),
  };
});

import { core } from '#lib/core/__mocks__/context.js';

import ThreadList from './ThreadList.svelte';

const listThreads = vi.fn();
Object.assign(core, { listThreads });

afterEach(() => {
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
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
  };
}

const rows = () => within(screen.getByRole('list')).getAllByRole('listitem');

test('lists thread roots page by page and opens the one picked', async () => {
  const user = userEvent.setup();
  listThreads
    .mockResolvedValueOnce({ roots: [root('$a', 'First topic')], next_batch: 'next' })
    .mockResolvedValueOnce({ roots: [root('$b', 'Second topic')], next_batch: null });
  const onOpenThread = vi.fn();
  renderWithTooltips(ThreadList, {
    roomId: '!room:example.org',
    members: [],
    onOpenThread,
    onClose: vi.fn(),
  });
  await vi.waitFor(() => {
    expect(rows()).toHaveLength(1);
  });
  expect(within(rows()[0]).getByText('Ana')).toBeInTheDocument();
  expect(within(rows()[0]).getByText('First topic')).toBeInTheDocument();
  expect(within(rows()[0]).getByRole('button', { name: 'Open thread' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Load more threads' }));
  await vi.waitFor(() => {
    expect(rows()).toHaveLength(2);
  });
  expect(listThreads).toHaveBeenLastCalledWith('!room:example.org', 'next');
  expect(screen.queryByRole('button', { name: 'Load more threads' })).not.toBeInTheDocument();

  await user.click(within(rows()[1]).getByText('Second topic'));
  expect(onOpenThread).toHaveBeenCalledWith('$b');
});

test('says so when a room has no threads', async () => {
  listThreads.mockResolvedValueOnce({ roots: [], next_batch: null });
  renderWithTooltips(ThreadList, {
    roomId: '!room:example.org',
    members: [],
    onOpenThread: vi.fn(),
    onClose: vi.fn(),
  });

  expect(await screen.findByText('No threads in this room yet.')).toBeInTheDocument();
});

test('a root shows its reply count and latest reply instead of an open button', async () => {
  const user = userEvent.setup();
  listThreads.mockResolvedValueOnce({
    roots: [
      {
        ...root('$a', 'First topic'),
        thread_summary: { num_replies: 3, latest_event_id: '$z', latest_body: 'Last word' },
      },
    ],
    next_batch: null,
  });
  const onOpenThread = vi.fn();
  renderWithTooltips(ThreadList, {
    roomId: '!room:example.org',
    members: [],
    onOpenThread,
    onClose: vi.fn(),
  });

  const summary = await screen.findByRole('button', { name: /3 replies/ });
  expect(summary).toHaveTextContent('Last word');
  expect(screen.queryByRole('button', { name: 'Open thread' })).not.toBeInTheDocument();

  await user.click(summary);
  expect(onOpenThread).toHaveBeenCalledWith('$a');
});

test('thread previews show the sender profile color and pronouns', async () => {
  core.userProfile.mockResolvedValue({
    name_color_light: '#2f5a1f',
    name_color_dark: '#9fd07c',
    pronouns: [{ summary: 'they/them', language: null }],
  });
  listThreads.mockResolvedValueOnce({ roots: [root('$a', 'First topic')], next_batch: null });
  renderWithTooltips(ThreadList, {
    roomId: '!room:example.org',
    members: [],
    onOpenThread: vi.fn(),
    onClose: vi.fn(),
  });

  await vi.waitFor(() => {
    expect(core.userProfile).toHaveBeenCalledWith(
      '@ana:example.org',
      false,
      expect.any(AbortSignal)
    );
    expect(screen.getByText('they/them')).toBeInTheDocument();
  });
  expect(document.querySelector('.message')?.getAttribute('style')).toContain(
    '--name-color-on-light: #2f5a1f'
  );
});
