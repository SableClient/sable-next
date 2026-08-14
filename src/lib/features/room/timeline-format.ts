import type { TimelineItemView } from '@/generated/TimelineItemView';
import type { TimelinePreferences } from '$lib/settings/timeline-preferences.svelte';

// Digits and a few ASCII marks are Emoji_Component, so a pictographic
// character has to be present for a body to count as emoji-only.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const JUMBO_MAX = 8;

/** Emoji-only bodies render larger, stepping down as the count grows. */
export function jumboEmojiLevel(body: string): 1 | 2 | 3 | 4 | null {
  const trimmed = body.trim();
  if (!trimmed || !PICTOGRAPHIC.test(trimmed) || !EMOJI_ONLY.test(trimmed)) return null;

  const segmenter = new Intl.Segmenter();
  const count = [...segmenter.segment(trimmed)].filter((unit) => unit.segment.trim()).length;
  if (count > JUMBO_MAX) return null;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return count <= 4 ? 3 : 4;
}

/** Dividers and markers annotate a run of events; they cannot justify one. */
function isAnnotation(item: TimelineItemView): boolean {
  const kind = item.content.kind;
  return kind === 'date_divider' || kind === 'read_marker' || kind === 'timeline_start';
}

function isVisibleEvent(item: TimelineItemView, preferences: TimelinePreferences): boolean {
  switch (item.content.kind) {
    case 'membership':
      // `other` is the SDK reporting a member event it could not classify.
      return !preferences.hideMembershipEvents && item.content.change !== 'other';
    case 'profile_change':
      return !preferences.hideProfileChanges;
    case 'state_event':
      return preferences.showHiddenEvents;
    default:
      return true;
  }
}

/** A divider left with nothing under it would render as a stray date. */
export function visibleTimelineItems(
  items: readonly TimelineItemView[],
  preferences: TimelinePreferences
): TimelineItemView[] {
  const kept = items.filter((item) => isVisibleEvent(item, preferences));

  const visible: TimelineItemView[] = [];
  let hasEventBelow = false;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const item = kept[index];
    if (item.content.kind === 'date_divider') {
      if (!hasEventBelow) continue;
      hasEventBelow = false;
    } else if (!isAnnotation(item)) {
      hasEventBelow = true;
    }
    visible.push(item);
  }
  return visible.reverse();
}

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
