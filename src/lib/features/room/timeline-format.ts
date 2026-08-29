import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
import type { TimelineItemContentView } from '#src/generated/TimelineItemContentView';
import type { TimelineItemView } from '#src/generated/TimelineItemView';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { TimelinePreferences } from '#lib/settings/preferences.svelte.js';

const MESSAGE_ROW_KINDS = [
  'message',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'gallery',
  'location',
  'poll',
] as const satisfies readonly TimelineItemContentView['kind'][];

export type MessageContent = Extract<
  TimelineItemContentView,
  { kind: (typeof MESSAGE_ROW_KINDS)[number] }
>;

/** Rows that carry a sender, a hover menu and reactions. */
export function isMessageRow(content: TimelineItemContentView): content is MessageContent {
  return (MESSAGE_ROW_KINDS as readonly string[]).includes(content.kind);
}

/** An image, a poll or a location you posted is yours to delete too. */
export function canRedact(item: TimelineItemView, canRedactOthers: boolean): boolean {
  if (!isMessageRow(item.content)) return false;
  return item.is_own || canRedactOthers;
}

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
      if (item.content.change) return true;
      return preferences.showHiddenEvents && preferences.showNonStandardEvents;
    case 'hidden_event':
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

const UNREAD_KINDS = new Set<TimelineItemContentView['kind']>([
  'message',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'gallery',
  'location',
  'poll',
  'unable_to_decrypt',
]);

export function unreadCountAfter(items: readonly TimelineItemView[], index: number): number {
  let count = 0;
  for (let next = index + 1; next < items.length; next += 1) {
    const item = items[next];
    if (!item.is_own && UNREAD_KINDS.has(item.content.kind)) count += 1;
  }
  return count;
}

export type PersonaLookup = (eventId: string) => PerMessageProfileView | null;

export function personaLookup(items: readonly TimelineItemView[]): PersonaLookup {
  let personas: Map<string, PerMessageProfileView> | null = null;

  return (eventId) => {
    if (personas === null) {
      personas = new Map();
      for (const item of items) {
        if (item.event_id && item.per_message_profile) {
          personas.set(item.event_id, item.per_message_profile);
        }
      }
    }

    return personas.get(eventId) ?? null;
  };
}

const senderColors = [
  'var(--sable-primary-main)',
  'var(--sable-sec-main)',
  'var(--sable-success-main)',
  'var(--sable-warn-main)',
  'var(--sable-crit-main)',
];

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
    const eventId = items[index].event_id;
    if (eventId) return eventId;
  }
  return null;
}

/**
 * The newest event scrolled past, never an older one: history loading below the
 * reader, or a jump back up, would otherwise walk the receipt backwards.
 */
export function readReceiptEventId(
  items: readonly TimelineItemView[],
  options: {
    visibleEventId: string | null;
    documentVisible: boolean;
    lastReadEventId: string | null;
  }
): string | null {
  const { visibleEventId, lastReadEventId } = options;
  if (!options.documentVisible || visibleEventId === null) return null;
  if (visibleEventId === lastReadEventId) return null;
  if (lastReadEventId === null) return visibleEventId;

  const seen = items.findIndex((item) => item.event_id === lastReadEventId);
  const next = items.findIndex((item) => item.event_id === visibleEventId);
  if (seen === -1 || next === -1) return visibleEventId;
  return next > seen ? visibleEventId : null;
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

export function hasNewLocalEcho(
  previous: readonly TimelineItemView[],
  next: readonly TimelineItemView[]
): boolean {
  const pending = new Set<string>();
  for (const item of previous) {
    if (item.transaction_id !== null) pending.add(item.transaction_id);
  }
  return next.some((item) => item.transaction_id !== null && !pending.has(item.transaction_id));
}
