import type { TimelineItemView } from '@/generated/TimelineItemView';

const senderColors = [
  'var(--sable-primary-main)',
  'var(--sable-sec-main)',
  'var(--sable-success-main)',
  'var(--sable-warn-main)',
  'var(--sable-crit-main)',
];

export function initials(name: string): string {
  return name.slice(0, 1).toLocaleUpperCase();
}

export function senderColor(sender: string | null): string {
  if (!sender) return senderColors[0];
  let hash = 0;
  for (const character of sender) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return senderColors[Math.abs(hash) % senderColors.length];
}

export function isCollapsed(items: readonly TimelineItemView[], index: number): boolean {
  if (index === 0) return false;
  const current = items[index];
  const previous = items[index - 1];
  return (
    current.content.kind === 'message' &&
    previous.content.kind === 'message' &&
    current.sender !== null &&
    current.sender === previous.sender &&
    current.timestamp - previous.timestamp < 120_000
  );
}

export function latestEventId(items: readonly TimelineItemView[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const eventId = items[index]?.event_id;
    if (eventId) return eventId;
  }
  return null;
}

export function readReceiptEventId(
  items: readonly TimelineItemView[],
  options: {
    focusEventId: string | null;
    initialAnchorComplete: boolean;
    nearLatest: boolean;
    documentVisible: boolean;
    lastReadEventId: string | null;
  }
): string | null {
  if (
    options.focusEventId !== null ||
    !options.initialAnchorComplete ||
    !options.nearLatest ||
    !options.documentVisible
  ) {
    return null;
  }

  const eventId = latestEventId(items);
  return eventId === options.lastReadEventId ? null : eventId;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
