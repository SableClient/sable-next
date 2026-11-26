// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';
import type { CoreEvent } from '#src/generated/protocol';
import { settleFirstRoom } from '#lib/rooms/first-room-gate.js';
import { RoomUnreadMentions } from './room-unread-mentions.svelte.js';

settleFirstRoom();

function setup() {
  let emit!: (event: CoreEvent) => void;
  const inbox = vi.fn((_request: { room_id: string | null }) =>
    Promise.resolve({ items: [], has_more: false })
  );
  const backfillInbox = vi.fn(() => Promise.resolve({ has_more: false }));
  const core = {
    rpc: { notifications: { inbox, backfillInbox } },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      emit = listener;
      return () => {};
    },
  };
  const room = $state({ id: '!a:example.org', highlight: 1 });
  const cleanup = $effect.root(() => {
    new RoomUnreadMentions(
      core as never,
      () => room.id,
      () => room.highlight
    );
  });
  flushSync();
  return { room, inbox, backfillInbox, emit, cleanup };
}

async function settle(): Promise<void> {
  flushSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function loadsFor(inbox: ReturnType<typeof setup>['inbox'], roomId: string): number {
  return inbox.mock.calls.filter(([request]) => request.room_id === roomId).length;
}

test('opening a room loads mentions once now and once after the backfill', async () => {
  const { inbox, backfillInbox, cleanup } = setup();
  await settle();

  expect(backfillInbox).toHaveBeenCalledOnce();
  expect(loadsFor(inbox, '!a:example.org')).toBe(2);
  cleanup();
});

test('a highlight change in the same room reloads once', async () => {
  const { room, inbox, backfillInbox, cleanup } = setup();
  await settle();

  room.highlight = 0;
  await settle();

  expect(loadsFor(inbox, '!a:example.org')).toBe(3);
  expect(backfillInbox).toHaveBeenCalledOnce();
  cleanup();
});

test.each([
  ['with', 5],
  ['without', 1],
])('switching rooms %s a highlight change loads the new room twice', async (_, nextHighlight) => {
  const { room, inbox, backfillInbox, cleanup } = setup();
  await settle();

  room.id = '!b:example.org';
  room.highlight = nextHighlight;
  await settle();

  expect(loadsFor(inbox, '!a:example.org')).toBe(2);
  expect(loadsFor(inbox, '!b:example.org')).toBe(2);
  expect(backfillInbox).toHaveBeenCalledTimes(2);

  room.highlight = nextHighlight + 1;
  await settle();
  expect(loadsFor(inbox, '!b:example.org')).toBe(3);
  cleanup();
});

test('an inbox change reloads the current room', async () => {
  const { inbox, emit, cleanup } = setup();
  await settle();

  emit({ type: 'inbox_changed' });
  await settle();

  expect(loadsFor(inbox, '!a:example.org')).toBe(3);
  cleanup();
});
