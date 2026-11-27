// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { TimelineItemView, UrlPreviewView } from '#src/generated/protocol';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { MessageActionExecutor } from './message-action-controller.svelte.js';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

const writeClipboard = vi.fn((_text?: string) => Promise.resolve());
vi.mock('#lib/platform/clipboard.js', () => ({
  copyText: (text: string) => writeClipboard(text),
}));

const features = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('#lib/core/server-features.svelte.js', () => ({
  serverFeatures: () => features.list,
}));

function message(): TimelineItemView {
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
      body: 'hello',
      html: '<b>hello</b>',
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
    linkPreviews: [] as UrlPreviewView[],
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onOpenThread: vi.fn(),
    onReply: vi.fn(),
  };
  const source = Promise.withResolvers<{
    source: string;
    encrypted: boolean;
    original: string | null;
    encryption: string | null;
  }>();
  const removeLinkPreviews = vi.fn(() => Promise.resolve());
  const deps = {
    core: {
      commands: {
        imagePacks: vi.fn(),
      },
      rpc: {
        messages: { removeLinkPreviews },
        timeline: { eventSource: vi.fn(() => source.promise) },
      },
    } as unknown as CoreClient,
    personaStore: { load: vi.fn(async () => {}) },
    pinnedEvents: { has: vi.fn(() => false), toggle: vi.fn(async () => {}) },
    bookmarks: { has: vi.fn(() => false), toggle: vi.fn(async () => {}) },
    dialogs: { open: vi.fn() },
    isDirect: vi.fn(() => false),
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
  source.resolve({
    source: '{"event_id":"$item"}',
    encrypted: true,
    original: '{"type":"m.room.encrypted"}',
    encryption: '{"session":null}',
  });
  await source.promise;
  await Promise.resolve();
  expect(deps.dialogs.open).toHaveBeenCalledWith(selected, {
    kind: 'source',
    source: '{"event_id":"$item"}',
    encrypted: true,
    original: '{"type":"m.room.encrypted"}',
    encryption: '{"session":null}',
  });
});

test('removing embeds edits the message in its own thread', () => {
  const { context, removeLinkPreviews, executor } = fixture();
  context.hasLinkPreviews = true;
  context.item.thread_root = '$root';

  executor.actions.onRemoveLinkPreviews?.();

  expect(removeLinkPreviews).toHaveBeenCalledWith({
    room_id: '!room',
    event_id: '$item',
    thread_root: '$root',
  });
});

test('copying message text writes to clipboard and shows confirmation toast', async () => {
  const { executor } = fixture();
  for (const toast of toasts.items) toasts.dismiss(toast.id);
  executor.actions.onCopyText?.();
  await Promise.resolve();
  expect(writeClipboard).toHaveBeenCalledWith('hello');
  expect(toasts.items.at(-1)?.message).toBe('Copied');
});

test('a direct chat does not offer deleted content to the people in it', () => {
  const { context, deps, executor } = fixture();
  context.item.is_own = false;
  context.item.content = { kind: 'redacted', reason: null, redacted_by: null };
  context.canRedactOthers = true;
  features.list = ['fi.mau.msc2815'];
  expect(executor.actions.onViewRedacted).toBeDefined();
  deps.isDirect.mockReturnValue(true);
  expect(executor.actions.onViewRedacted).toBeUndefined();
  features.list = [];
});

test('developer tools offer deleted content without the redact level when the server supports it', () => {
  const { context, executor } = fixture();
  context.item.is_own = false;
  context.item.content = { kind: 'redacted', reason: null, redacted_by: null };
  features.list = ['fi.mau.msc2815'];
  expect(executor.actions.onViewRedacted).toBeUndefined();
  preferences.developerTools = true;
  expect(executor.actions.onViewRedacted).toBeDefined();
  features.list = [];
  expect(executor.actions.onViewRedacted).toBeUndefined();
  context.canRedactOthers = true;
  context.item.redacted_on_ban = true;
  expect(executor.actions.onViewRedacted).toBeDefined();
  preferences.developerTools = false;
});
