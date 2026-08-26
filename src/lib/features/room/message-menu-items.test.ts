import { expect, test } from 'vitest';

import { messageMenuRows } from './message-menu-items.js';

test('reply offers one row, not a second that claims to open a thread', () => {
  const rows = messageMenuRows({ onReply: () => {} });

  expect(rows.map((row) => row.key)).toEqual(['reply']);
});

test('bookmark reads back the state it was given', () => {
  const bookmarked = messageMenuRows({ onBookmark: () => {}, bookmarked: true });
  const plain = messageMenuRows({ onBookmark: () => {}, bookmarked: false });

  expect(bookmarked.find((row) => row.key === 'bookmark')?.label).toBe(
    'timeline.unbookmarkMessage'
  );
  expect(plain.find((row) => row.key === 'bookmark')?.label).toBe('timeline.bookmarkMessage');
});

test('an action with no handler contributes no row', () => {
  expect(messageMenuRows({})).toEqual([]);
});
