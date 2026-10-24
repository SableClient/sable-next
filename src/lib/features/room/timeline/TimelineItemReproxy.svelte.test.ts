// @vitest-environment happy-dom

import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const edit = vi.fn(() => Promise.resolve());
const core = Object.assign(baseCore, {
  pinnedEvents: vi.fn(() => Promise.resolve<string[]>([])),
  setPinned: vi.fn(() => Promise.resolve<string[]>([])),
  bookmarks: vi.fn(() => Promise.resolve([])),
  setBookmark: vi.fn(() => Promise.resolve(false)),
});
Object.assign(core.rpc.messages, { edit });

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

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

function plainMultiline(): ResolvedItem {
  return withRowFields({
    id: 'item',
    event_id: '$item',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: 'one\ntwo',
      html: '<span data-plain-body>one\ntwo</span>',
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
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
  });
}

test('re-attaching a profile to a plain multiline message leaves its newlines to the body', async () => {
  const user = userEvent.setup({ delay: null });
  render(TimelineItemHarness, {
    props: { core, item: { item: plainMultiline(), collapsed: false, onEdit: vi.fn() } },
  });
  await tick();

  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');
  await user.pointer({ keys: '[MouseRight]', target: message });
  await user.click(screen.getByRole('menuitem', { name: /Send as a different profile/ }));
  await user.click(await screen.findByRole('button', { name: 'No profile' }));

  await vi.waitFor(() => {
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'one\ntwo', formatted: null })
    );
  });
});
