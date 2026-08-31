export type UnreadBadgeMode = 'dot' | 'count';

export interface UnreadBadgeCounts {
  unread: number;
  highlight: number;
  marked?: boolean;
}

export interface UnreadBadgeSettings {
  showUnreadCounts: boolean;
  badgeCountDMsOnly: boolean;
  showPingCounts: boolean;
}

export interface UnreadBadgeView {
  mode: UnreadBadgeMode;
  count: number;
  highlight: boolean;
}

export function resolveUnreadBadge(
  counts: UnreadBadgeCounts | undefined,
  settings: UnreadBadgeSettings,
  dm = false
): UnreadBadgeView | null {
  if (counts === undefined) return null;

  const highlight = counts.highlight > 0;
  const count = highlight ? counts.highlight : counts.unread;
  if (count <= 0) {
    return counts.marked ? { mode: 'dot', count: 0, highlight: false } : null;
  }

  const numeric =
    (dm && settings.badgeCountDMsOnly) ||
    (!dm && settings.showUnreadCounts) ||
    (highlight && settings.showPingCounts);

  return { mode: numeric ? 'count' : 'dot', count, highlight };
}

export function formatUnreadCount(count: number): string {
  if (count <= 999) return String(count);

  return count === 1000 ? '1k' : '1k+';
}
