export type UnreadBadgeMode = 'dot' | 'count';

export interface UnreadBadgeCounts {
  unread: number;
  highlight: number;
  marked?: boolean;
  notifying?: number;
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

  const mention = counts.highlight > 0;
  const count = mention ? counts.highlight : counts.unread;
  if (count <= 0) {
    return counts.marked ? { mode: 'dot', count: 0, highlight: false } : null;
  }

  const notified = (counts.notifying ?? 0) > 0;
  const highlight = mention || notified;
  const all = (dm && settings.badgeCountDMsOnly) || (!dm && settings.showUnreadCounts);
  const numeric = mention ? all || settings.showPingCounts : notified;
  if (!numeric) return { mode: 'dot', count, highlight };

  return { mode: 'count', count: mention ? count : (counts.notifying ?? count), highlight };
}

export function formatUnreadCount(count: number): string {
  if (count <= 999) return String(count);

  return count === 1000 ? '1k' : '1k+';
}
