// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const withdrawVerification = vi.fn(() => Promise.resolve());
const core = Object.assign(baseCore, {
  pinnedEvents: vi.fn(() => Promise.resolve<string[]>([])),
  setPinned: vi.fn(() => Promise.resolve<string[]>([])),
  bookmarks: vi.fn(() => Promise.resolve([])),
  setBookmark: vi.fn(() => Promise.resolve(false)),
  withdrawVerification,
});

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
  return { ...actual, usePresenceStore: () => ({ get: () => null }) };
});

import TimelineItemHarness from './TimelineItemHarness.test.svelte';

function failed(blocked: NonNullable<TimelineItemView['send_state']>): TimelineItemView {
  return {
    id: 'item',
    event_id: null,
    transaction_id: 'txn',
    send_state: blocked,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: 'hello',
      html: 'hello',
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
}

test('a send blocked by a changed identity explains why and can go out anyway', async () => {
  const onRetrySend = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: failed({
          status: 'failed',
          error: 'Some users that were previously verified are not anymore',
          recoverable: false,
          blocked: { kind: 'identity_changed', user_ids: ['@bob:example.org'] },
        }),
        collapsed: false,
        onRetrySend,
      },
    },
  });
  await tick();

  expect(screen.getByText(/reset their encryption identity/)).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));

  expect(withdrawVerification).toHaveBeenCalledWith('@bob:example.org');
  await vi.waitFor(() => {
    expect(onRetrySend).toHaveBeenCalledWith('txn');
  });
});

test('a send that needs this device verified says so', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: failed({
          status: 'failed',
          error: 'Own verification is required',
          recoverable: false,
          blocked: { kind: 'verify_this_device' },
        }),
        collapsed: false,
      },
    },
  });
  await tick();

  expect(
    screen.getByText('Verify this device before sending encrypted messages.')
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send anyway' })).not.toBeInTheDocument();
});
