import { expect, test } from 'vitest';

import { formatUnreadCount, hideQuietDot, resolveUnreadBadge } from './unread-badge.js';

const off = { showUnreadCounts: false, badgeCountDMsOnly: false, showPingCounts: false };

test('nothing to badge yields nothing', () => {
  expect(resolveUnreadBadge(undefined, off)).toBeNull();
  expect(resolveUnreadBadge({ unread: 0, highlight: 0 }, off)).toBeNull();
});

test('a hand-marked room dots with no count', () => {
  expect(resolveUnreadBadge({ unread: 0, highlight: 0, marked: true }, off)).toEqual({
    mode: 'dot',
    count: 0,
    highlight: false,
  });
  expect(
    resolveUnreadBadge(
      { unread: 0, highlight: 0, marked: true },
      {
        ...off,
        showUnreadCounts: true,
      }
    )?.mode
  ).toBe('dot');
});

test('a count setting never numbers messages that did not notify', () => {
  const counts = { unread: 4, highlight: 0, notifying: 0 };

  expect(resolveUnreadBadge(counts, { ...off, showUnreadCounts: true })?.mode).toBe('dot');
  expect(resolveUnreadBadge(counts, { ...off, badgeCountDMsOnly: true }, true)?.mode).toBe('dot');
});

test('a direct chat mention follows the direct-message count setting', () => {
  const counts = { unread: 4, highlight: 1 };

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

test('a room whose ordinary messages notify counts them, and counts them loudly', () => {
  const counts = { unread: 6, highlight: 0, notifying: 6 };

  expect(resolveUnreadBadge(counts, off)).toEqual({ mode: 'count', count: 6, highlight: true });
});

test('a notifying room still counts a mention as the mention', () => {
  const counts = { unread: 9, highlight: 2, notifying: 9 };

  expect(resolveUnreadBadge(counts, { ...off, showPingCounts: true })).toEqual({
    mode: 'count',
    count: 2,
    highlight: true,
  });
});

test('a room that notified nothing keeps its quiet dot', () => {
  expect(resolveUnreadBadge({ unread: 6, highlight: 0, notifying: 0 }, off)).toEqual({
    mode: 'dot',
    count: 6,
    highlight: false,
  });
});

test('notifying does not resurrect a room with nothing unread', () => {
  expect(resolveUnreadBadge({ unread: 0, highlight: 0, notifying: 0 }, off)).toBeNull();
});

test('an aggregate counts what notified, not every unread message under it', () => {
  const counts = { unread: 32, highlight: 0, notifying: 2 };

  expect(resolveUnreadBadge(counts, off)).toEqual({ mode: 'count', count: 2, highlight: true });
  expect(resolveUnreadBadge(counts, { ...off, showUnreadCounts: true })).toEqual({
    mode: 'count',
    count: 2,
    highlight: true,
  });
});

test('hiding unread dots keeps mentions, counts and hand-marked rooms', () => {
  const quiet = resolveUnreadBadge({ unread: 4, highlight: 0, notifying: 0 }, off);
  const mention = resolveUnreadBadge({ unread: 4, highlight: 1 }, off);
  const counted = resolveUnreadBadge({ unread: 4, highlight: 0, notifying: 2 }, off);
  const marked = resolveUnreadBadge({ unread: 0, highlight: 0, marked: true }, off);

  expect(hideQuietDot(quiet, true)).toEqual(quiet);
  expect(hideQuietDot(quiet, false)).toBeNull();
  expect(hideQuietDot(mention, false)).toEqual(mention);
  expect(hideQuietDot(counted, false)).toEqual(counted);
  expect(hideQuietDot(marked, false)).toEqual(marked);
});
