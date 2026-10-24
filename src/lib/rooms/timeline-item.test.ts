import { expect, test } from 'vitest';

import type { TimelineItemView, TimelineRowView } from '#src/generated/protocol';

import { resolveItem, resolveRow } from './timeline-item.js';

const wireItem = {
  id: '1',
  row: 'message',
  timestamp: 5,
  content: { kind: 'message', body: 'hi', html: 'hi' },
} satisfies TimelineItemView;

test('an item the wire left bare has its defaults', () => {
  const item = resolveItem(wireItem);

  expect(item).toMatchObject({
    forwardable: false,
    visibility: 'always',
    event_id: null,
    sender: null,
    reactions: [],
    is_own: false,
    read_by: [],
    read_timestamps: {},
    mention: 'none',
    forum_title: null,
    content: { kind: 'message', body: 'hi', emote: false, notice: false, edited: false },
  });
});

test('what the wire sent is kept over the defaults', () => {
  const item = resolveItem({
    ...wireItem,
    event_id: '$e',
    is_own: true,
    reactions: [{ key: '👍', senders: ['@a:x'] }],
    content: { kind: 'message', body: 'hi', html: 'hi', edited: true, jumbo: 2 },
  });

  expect(item.event_id).toBe('$e');
  expect(item.is_own).toBe(true);
  expect(item.reactions).toHaveLength(1);
  expect(item.content).toMatchObject({ edited: true, notice: false, jumbo: 2 });
});

test('the same wire item resolves to the same object', () => {
  expect(resolveItem(wireItem)).toBe(resolveItem(wireItem));
});

test('a row names its own readers and the later ones together', () => {
  const row: TimelineRowView = {
    key: 'k',
    reply_target: true,
    item: { ...wireItem, read_by: ['@a:x'], read_timestamps: { '@a:x': 1 } },
    later_receipts: { readers: ['@b:x'], timestamps: { '@b:x': 2 } },
  };

  const resolved = resolveRow(row);

  expect(resolved).toMatchObject({
    group: null,
    segments: [],
    collapsed: false,
    group_start: false,
    unread_count: 0,
    receipts: { readers: ['@a:x', '@b:x'], timestamps: { '@a:x': 1, '@b:x': 2 } },
  });
});

test('a row nobody has read has no receipts', () => {
  expect(resolveRow({ key: 'k', reply_target: false, item: wireItem }).receipts).toBeNull();
});
