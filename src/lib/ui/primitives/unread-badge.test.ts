import { expect, test } from 'vitest';

import { formatUnreadCount, resolveUnreadBadge } from './unread-badge.js';

const off = { showUnreadCounts: false, badgeCountDMsOnly: false, showPingCounts: false };

test('nothing to badge yields nothing', () => {
  expect(resolveUnreadBadge(undefined, off)).toBeNull();
  expect(resolveUnreadBadge({ unread: 0, highlight: 0 }, off)).toBeNull();
});

test('a room counts its messages only where room counts are on', () => {
  const counts = { unread: 4, highlight: 0 };

  expect(resolveUnreadBadge(counts, { ...off, showUnreadCounts: true })).toEqual({
    mode: 'count',
    count: 4,
    highlight: false,
  });
  expect(resolveUnreadBadge(counts, off)?.mode).toBe('dot');
});

test('a direct chat follows the direct-message count setting', () => {
  const counts = { unread: 4, highlight: 0 };

  expect(resolveUnreadBadge(counts, { ...off, badgeCountDMsOnly: true }, true)?.mode).toBe('count');
  expect(resolveUnreadBadge(counts, { ...off, showUnreadCounts: true }, true)?.mode).toBe('dot');
});

test('a mention counts mentions, not messages', () => {
  const counts = { unread: 9, highlight: 2 };

  expect(resolveUnreadBadge(counts, { ...off, showPingCounts: true })).toEqual({
    mode: 'count',
    count: 2,
    highlight: true,
  });
  expect(resolveUnreadBadge(counts, off)).toEqual({ mode: 'dot', count: 2, highlight: true });
});

test('counts stop spelling themselves out past a thousand', () => {
  expect(formatUnreadCount(1)).toBe('1');
  expect(formatUnreadCount(999)).toBe('999');
  expect(formatUnreadCount(1000)).toBe('1k');
  expect(formatUnreadCount(1001)).toBe('1k+');
});
