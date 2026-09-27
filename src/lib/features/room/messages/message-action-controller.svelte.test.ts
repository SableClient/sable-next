// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { TimelineItemView } from '#src/generated/protocol';
import { MessageActionExecutor } from './message-action-controller.svelte.js';

function message(): TimelineItemView {
  return {
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
      body: 'hello',
      html: '<b>hello</b>',
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
}

function fixture() {
  const context = {
    item: message(),
    roomId: '!room',
    canPin: true,
    canRedactOwn: true,
    canRedactOthers: false,
    senderTimezone: null,
    anchor: null,
    hasLinkPreviews: false,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onOpenThread: vi.fn(),
    onReply: vi.fn(),
  };
  const source = Promise.withResolvers<string>();
  const removeLinkPreviews = vi.fn(() => Promise.resolve());
  const deps = {
    core: {
      commands: {
        imagePacks: vi.fn(),
        eventSource: vi.fn(() => source.promise),
        removeLinkPreviews,
      },
    } as unknown as CoreClient,
    personaStore: { load: vi.fn(async () => {}) },
    pinnedEvents: { has: vi.fn(() => false), toggle: vi.fn(async () => {}) },
    bookmarks: { has: vi.fn(() => false), toggle: vi.fn(async () => {}) },
    dialogs: { open: vi.fn() },
  };
  return {
    context,
    deps,
    source,
    removeLinkPreviews,
    executor: new MessageActionExecutor(() => context, deps),
  };
}

test('editing an unsent message uses its transaction id and does not offer server actions', () => {
  const { context, executor } = fixture();
  context.item.event_id = null;
  context.item.transaction_id = 'local';
  executor.actions.onEdit?.();
  expect(context.onEdit).toHaveBeenCalledWith('local', 'hello', '<b>hello</b>', false);
  expect(executor.actions.onPin).toBeUndefined();
  expect(executor.actions.onBookmark).toBeUndefined();
  expect(executor.actions.onViewSource).toBeUndefined();
  expect(executor.actions.onReproxy).toBeUndefined();
});

test('redaction and edit actions respect ownership and room permissions', () => {
  const { context, executor } = fixture();
  context.item.is_own = false;
  expect(executor.actions.onEdit).toBeUndefined();
  expect(executor.actions.onDelete).toBeUndefined();
  context.canRedactOthers = true;
  executor.actions.onDelete?.();
  expect(executor.actions.onReport).toBeDefined();
});

test('a thread reply opens the root and delete opens the selected event dialog', () => {
  const { context, executor, deps } = fixture();
  context.item.thread_root = '$root';
  executor.actions.onOpenThread?.();
  executor.actions.onDelete?.();
  expect(context.onOpenThread).toHaveBeenCalledWith('$root');
  expect(deps.dialogs.open).toHaveBeenCalledWith(context.item, { kind: 'delete', target: '$item' });
});

test('source lookup keeps the event selected when the action began', async () => {
  const { context, executor, deps, source } = fixture();
  const selected = context.item;
  executor.actions.onViewSource?.();
  context.item = { ...message(), event_id: '$next', id: 'next' };
  source.resolve('{"event_id":"$item"}');
  await source.promise;
  await Promise.resolve();
  expect(deps.dialogs.open).toHaveBeenCalledWith(selected, {
    kind: 'source',
    source: '{"event_id":"$item"}',
  });
});

test('removing embeds edits the message in its own thread', () => {
  const { context, removeLinkPreviews, executor } = fixture();
  context.hasLinkPreviews = true;
  context.item.thread_root = '$root';

  executor.actions.onRemoveLinkPreviews?.();

  expect(removeLinkPreviews).toHaveBeenCalledWith('!room', '$item', '$root');
});
