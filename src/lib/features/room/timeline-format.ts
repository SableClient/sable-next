import type { PerMessageProfileView } from '@/generated/PerMessageProfileView';
import type { TimelineItemView } from '@/generated/TimelineItemView';
import { preferences } from '$lib/settings/preferences.svelte';
import type { TimelinePreferences } from '$lib/settings/preferences.svelte';

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const JUMBO_MAX = 8;

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

function isAnnotation(item: TimelineItemView): boolean {
  const kind = item.content.kind;
  return kind === 'date_divider' || kind === 'read_marker' || kind === 'timeline_start';
}

export interface TimelineFilterContext {
  readOnly?: boolean;
}

function isVisibleEvent(
  item: TimelineItemView,
  preferences: TimelinePreferences,
  context: TimelineFilterContext
): boolean {
  const memberEventsHidden = Boolean(context.readOnly) && preferences.hideMemberInReadOnly;
  switch (item.content.kind) {
    case 'membership':
      return (
        !preferences.hideMembershipEvents && !memberEventsHidden && item.content.change !== 'other'
      );
    case 'profile_change':
      return !preferences.hideProfileChanges && !memberEventsHidden;
    case 'redacted':
      return preferences.showTombstoneEvents;
    case 'state_event':
      return preferences.showHiddenEvents && preferences.showNonStandardEvents;
    default:
      return true;
  }
}

export function visibleTimelineItems(
  items: readonly TimelineItemView[],
  preferences: TimelinePreferences,
  context: TimelineFilterContext = {}
): TimelineItemView[] {
  const kept = items.filter((item) => isVisibleEvent(item, preferences, context));

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

const MESSAGE_KINDS = new Set([
  'message',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'unable_to_decrypt',
]);

export function unreadCountAfter(items: readonly TimelineItemView[], index: number): number {
  let count = 0;
  for (let next = index + 1; next < items.length; next += 1) {
    const item = items[next];
    if (!item.is_own && MESSAGE_KINDS.has(item.content.kind)) count += 1;
  }
  return count;
}

export function personasByEventId(
  items: readonly TimelineItemView[]
): Map<string, PerMessageProfileView> {
  const personas = new Map<string, PerMessageProfileView>();
  for (const item of items) {
    if (item.event_id && item.per_message_profile) {
      personas.set(item.event_id, item.per_message_profile);
    }
  }
  return personas;
}

const FOLDABLE_KINDS = new Set(['membership', 'profile_change', 'state_event']);
const FOLD_MIN_RUN = 3;
export const FOLD_SUMMARY_COUNT = 2;

export interface FoldedTimeline {
  items: TimelineItemView[];
  runs: Map<string, TimelineItemView[]>;
}

export function foldEventRuns(items: readonly TimelineItemView[]): FoldedTimeline {
  const folded: TimelineItemView[] = [];
  const runs = new Map<string, TimelineItemView[]>();

  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!FOLDABLE_KINDS.has(item.content.kind)) {
      folded.push(item);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < items.length && FOLDABLE_KINDS.has(items[end].content.kind)) end += 1;
    const run = items.slice(index, end);
    folded.push(item);
    if (run.length >= FOLD_MIN_RUN) runs.set(item.id, run);
    else folded.push(...run.slice(1));
    index = end;
  }

  return { items: folded, runs };
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

function personaKey(item: TimelineItemView): string {
  const profile = item.per_message_profile;
  if (!profile) return '';
  return profile.id ?? profile.display_name ?? '';
}

// Collapsing on sender alone would hide a persona behind the account's header.
export function isCollapsed(items: readonly TimelineItemView[], index: number): boolean {
  if (index === 0) return false;
  const current = items[index];
  const previous = items[index - 1];
  return (
    current.content.kind === 'message' &&
    previous.content.kind === 'message' &&
    current.sender !== null &&
    current.sender === previous.sender &&
    personaKey(current) === personaKey(previous) &&
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
    followingLive: boolean;
    nearLatest: boolean;
    documentVisible: boolean;
    lastReadEventId: string | null;
  }
): string | null {
  if (!options.followingLive || !options.nearLatest || !options.documentVisible) {
    return null;
  }

  const eventId = latestEventId(items);
  return eventId === options.lastReadEventId ? null : eventId;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(preferences.hour24Clock ? { hour12: false } : {}),
  });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear());
  switch (preferences.dateFormat) {
    case 'dmy':
      return `${day}/${month}/${year}`;
    case 'mdy':
      return `${month}/${day}/${year}`;
    case 'ymd':
      return `${year}-${month}-${day}`;
    default:
      return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
}
