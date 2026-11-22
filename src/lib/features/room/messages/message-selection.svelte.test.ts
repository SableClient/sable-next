import { expect, test, vi } from 'vitest';

import type { MemberView, TimelineItemView } from '#src/generated/protocol';
import { timelineItem } from '#lib/features/room/timeline/test-items.js';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

import {
  batchCapabilities,
  formatCopiedMessages,
  isSelectable,
  MessageSelection,
  messageCopyText,
  runBatch,
} from './message-selection.svelte.js';

function msg(
  id: string,
  body = `body-${id}`,
  overrides: Partial<TimelineItemView> = {}
): TimelineItemView {
  return { ...timelineItem(id, body), ...overrides };
}

function imageMsg(id: string, caption: string | null): TimelineItemView {
  return withRowFields({
    ...timelineItem(id, caption ?? ''),
    content: {
      kind: 'image',
      filename: 'pic.png',
      caption,
      html: null,
      source: 'mxc://example.org/pic',
      external_url: null,
      mime: 'image/png',
      width: 100,
      height: 100,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      animated: null,
    },
  });
}

test('isSelectable excludes dividers, sending, and failed items', () => {
  expect(isSelectable(msg('ok'))).toBe(true);
  expect(
    isSelectable(
      withRowFields({
        ...msg('div'),
        event_id: null,
        content: { kind: 'date_divider', timestamp: 0 },
      })
    )
  ).toBe(false);
  expect(
    isSelectable({
      ...msg('sending'),
      event_id: null,
      send_state: { status: 'sending', progress: null },
    })
  ).toBe(false);
  expect(
    isSelectable({
      ...msg('failed'),
      send_state: { status: 'failed', error: 'err', recoverable: true, blocked: null },
    })
  ).toBe(false);
});

test('MessageSelection manages toggle, range selection, live lookup, and subset retention', () => {
  const divider = withRowFields({
    ...msg('sep'),
    event_id: null,
    content: { kind: 'date_divider', timestamp: 0 },
  });
  let windowItems: TimelineItemView[] = [
    msg('a', 'a', { timestamp: 1 }),
    divider,
    msg('b', 'b', { timestamp: 2 }),
    msg('c', 'c', { timestamp: 3 }),
  ];
  const selection = new MessageSelection(() => windowItems);

  selection.enter(windowItems[3]);
  expect(selection.active).toBe(true);
  selection.selectRange(windowItems[0]);
  expect(selection.selected().map((item) => item.event_id)).toEqual(['$a', '$b', '$c']);

  selection.toggle(windowItems[0]);
  expect(selection.anchorId).toBeNull();
  selection.selectAll();
  expect(selection.count).toBe(3);

  const updatedA: TimelineItemView = {
    ...windowItems[0],
    content: {
      kind: 'message',
      body: 'edited-a',
      html: 'edited-a',
      msgtype: 'text',
      edited: true,
      jumbo: null,
    },
  };
  windowItems = [windowItems[2], windowItems[3]];
  const resolved = selection.selected({ get: (id) => (id === '$a' ? updatedA : null) });
  expect(resolved.map((item) => item.event_id)).toEqual(['$a', '$b', '$c']);
  expect(resolved[0].content.kind === 'message' && resolved[0].content.body).toBe('edited-a');

  selection.keepOnly(['$b']);
  expect(selection.selected().map((item) => item.event_id)).toEqual(['$b']);
  selection.toggle(windowItems[0]);
  expect(selection.active).toBe(false);
});

test('messageCopyText and formatCopiedMessages format single and multi-message copies', () => {
  const members = [
    { user_id: '@alice:example.org', display_name: 'Alice Display' },
    { user_id: '@bob:example.org', display_name: 'Bob Display' },
  ] as unknown as MemberView[];

  expect(messageCopyText(msg('empty', ''))).toBeNull();
  expect(messageCopyText(imageMsg('img', 'caption'))).toBe('caption');
  expect(formatCopiedMessages([imageMsg('none', null)], members)).toBe('');
  expect(formatCopiedMessages([msg('a', 'just one')], members)).toBe('just one');
  expect(
    formatCopiedMessages(
      [
        msg('a', 'first', { sender: '@alice:example.org' }),
        imageMsg('skip', null),
        msg('b', 'line1\nline2', { sender: '@bob:example.org' }),
      ],
      members
    )
  ).toBe('Alice Display: first\n\nBob Display: line1\nline2');
});

test('batchCapabilities filters eligible items by permissions, ownership, and bookmark state', () => {
  const own = msg('own', 'mine', { is_own: true });
  const other = msg('other', 'theirs', { is_own: false });
  const redacted = withRowFields({
    ...msg('red', '', { is_own: true }),
    content: { kind: 'redacted', reason: null, redacted_by: null },
  });
  const caps = batchCapabilities([own, other, redacted, imageMsg('img', null)], {
    roomId: '!room:example.org',
    canEdit: true,
    canDelete: true,
    canRedactOwn: true,
    canRedactOthers: false,
    bookmarks: { has: (_room, id) => id === '$own' },
  });

  expect(caps.copyable.map((i) => i.event_id)).toEqual(['$own', '$other']);
  expect(caps.forwardable.map((i) => i.event_id)).toEqual(['$own', '$other', '$img']);
  expect(caps.allBookmarked).toBe(false);
  expect(caps.reproxyable.map((i) => i.event_id)).toEqual(['$own']);
  expect(caps.reportable.map((i) => i.event_id)).toEqual(['$other', '$img']);
  expect(caps.deletable.map((i) => i.event_id)).toEqual(['$own']);
});

test('runBatch collects partial failures and honors abort signals', async () => {
  const partial = await runBatch(['a', 'b', 'c'], (entry) =>
    entry === 'b' ? Promise.reject(new Error('boom')) : Promise.resolve()
  );
  expect(partial.succeeded).toEqual(['a', 'c']);
  expect(partial.failed.map((f) => f.item)).toEqual(['b']);

  const controller = new AbortController();
  const seen: string[] = [];
  const aborted = await runBatch(
    ['a', 'b', 'c'],
    vi.fn((entry: string) => {
      seen.push(entry);
      if (entry === 'a') controller.abort();
      return Promise.resolve();
    }),
    { signal: controller.signal }
  );
  expect(seen).toEqual(['a']);
  expect(aborted.cancelled).toBe(true);
  expect(aborted.remaining).toEqual(['b', 'c']);
});
