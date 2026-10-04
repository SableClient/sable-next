import type {
  PerMessageProfileView,
  TimelineItemContentView,
  TimelineItemView,
} from '#src/generated/protocol';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { ReplyPreviewStyle, TimelinePreferences } from '#lib/settings/preferences.svelte.js';

export { senderColor } from '#lib/ui/primitives/identity-color.js';

const MESSAGE_ROW_KINDS = [
  'message',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'gallery',
  'location',
  'live_location',
  'poll',
  'redacted',
] as const satisfies readonly TimelineItemContentView['kind'][];

export type MessageContent = Extract<
  TimelineItemContentView,
  { kind: (typeof MESSAGE_ROW_KINDS)[number] }
>;

/** Rows that carry a sender, a hover menu and reactions. */
export function isMessageRow(content: TimelineItemContentView): content is MessageContent {
  return (MESSAGE_ROW_KINDS as readonly string[]).includes(content.kind);
}

const FORWARDABLE_KINDS = [
  'message',
  'image',
  'video',
  'audio',
  'file',
  'location',
  'gallery',
] as const satisfies readonly TimelineItemContentView['kind'][];

export function canForward(content: TimelineItemContentView): boolean {
  return (FORWARDABLE_KINDS as readonly string[]).includes(content.kind);
}

export function canRedact(
  item: TimelineItemView,
  canRedactOwn: boolean,
  canRedactOthers: boolean
): boolean {
  if (isAnnotation(item) || item.content.kind === 'redacted') return false;
  return item.is_own ? canRedactOwn : canRedactOthers;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const IMAGE_TAG = /<img\b(?:"[^"]*"|'[^']*'|[^>"'])*>/giu;
const MXC_IMAGE_SOURCE = /\bsrc=(?:"mxc:|'mxc:)/i;
const LINE_BREAK = /<br\b[^>]*>/giu;
const NO_BREAK_SPACE = /&(?:nbsp|#160);/giu;
const JUMBO_MAX = 8;

function jumboLevel(count: number): 1 | 2 | 3 | 4 | null {
  if (count === 0 || count > JUMBO_MAX) return null;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return count <= 4 ? 3 : 4;
}

export function jumboEmojiLevel(body: string): 1 | 2 | 3 | 4 | null {
  const trimmed = body.trim();
  if (!trimmed || !PICTOGRAPHIC.test(trimmed) || !EMOJI_ONLY.test(trimmed)) return null;

  const segmenter = new Intl.Segmenter();
  const count = [...segmenter.segment(trimmed)].filter((unit) => unit.segment.trim()).length;
  return jumboLevel(count);
}

export function jumboEmoticonLevel(html: string): 1 | 2 | 3 | 4 | null {
  const unwrapped = html
    .trim()
    .replace(/^<p[^>]*>/iu, '')
    .replace(/<\/p>$/iu, '');
  const images = unwrapped.match(IMAGE_TAG) ?? [];
  if (images.length === 0 || !images.every((image) => MXC_IMAGE_SOURCE.test(image))) return null;
  const residue = unwrapped
    .replace(IMAGE_TAG, '')
    .replace(LINE_BREAK, '')
    .replace(NO_BREAK_SPACE, ' ')
    .trim();
  if (residue !== '') return null;
  return jumboLevel(images.length);
}

export function isAnnotation(item: TimelineItemView): boolean {
  const kind = item.content.kind;
  return kind === 'date_divider' || kind === 'read_marker' || kind === 'timeline_start';
}

export function isEventRow(item: TimelineItemView): boolean {
  return !isMessageRow(item.content) && !isAnnotation(item);
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
      if (preferences.hideMembershipEvents || memberEventsHidden) return false;
      return item.content.change !== 'other' || preferences.showHiddenEvents;
    case 'profile_change':
      return !preferences.hideProfileChanges && !memberEventsHidden;
    case 'redacted':
      return preferences.showTombstoneEvents;
    case 'state_event':
      if (item.content.change) return true;
      return preferences.showHiddenEvents && preferences.hiddenEventOther;
    case 'hidden_event':
      return preferences.showHiddenEvents && preferences.hiddenEventOther;
    default:
      return true;
  }
}

export function visibleAggregations(
  aggregations: readonly TimelineItemView[],
  preferences: TimelinePreferences
): readonly TimelineItemView[] {
  if (!preferences.showHiddenEvents) return [];

  return aggregations.filter((item) => {
    if (item.content.kind !== 'hidden_event') return true;
    switch (item.content.event_type) {
      case 'm.reaction':
        return preferences.hiddenEventReactions;
      case 'm.room.redaction':
        return preferences.hiddenEventRedactions;
      case 'm.room.message':
        return preferences.hiddenEventEdits;
      default:
        return preferences.hiddenEventOther;
    }
  });
}

export function mergeAggregations(
  items: readonly TimelineItemView[],
  aggregations: readonly TimelineItemView[],
  loaded: { start: boolean; end: boolean }
): readonly TimelineItemView[] {
  if (aggregations.length === 0) return items;

  const events = items.filter((item) => item.event_id !== null);
  const oldest = loaded.start ? -Infinity : (events.at(0)?.timestamp ?? Infinity);
  const newest = loaded.end ? Infinity : (events.at(-1)?.timestamp ?? -Infinity);
  const known = new Set(items.map((item) => item.id));
  const pending = aggregations
    .filter((item) => !known.has(item.id) && item.timestamp >= oldest && item.timestamp <= newest)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (pending.length === 0) return items;

  const merged: TimelineItemView[] = [];
  let next = 0;
  for (const item of items) {
    while (next < pending.length && pending[next].timestamp <= item.timestamp) {
      merged.push(pending[next]);
      next += 1;
    }
    merged.push(item);
  }
  return merged.concat(pending.slice(next));
}

export function visibleTimelineItems(
  items: readonly TimelineItemView[],
  preferences: TimelinePreferences,
  context: TimelineFilterContext = {}
): TimelineItemView[] {
  const shown = new Set<string>();
  const kept = items.filter((item) => {
    if (item.event_id) {
      if (shown.has(item.event_id)) return false;
      shown.add(item.event_id);
    }
    return isVisibleEvent(item, preferences, context);
  });

  const visible: TimelineItemView[] = [];
  let hasEventBelow = false;
  let hasUnreadBelow = false;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const item = kept[index];
    if (item.content.kind === 'date_divider') {
      if (!hasEventBelow) continue;
      hasEventBelow = false;
    } else if (item.content.kind === 'read_marker') {
      if (!hasUnreadBelow) continue;
    } else if (!isAnnotation(item)) {
      hasEventBelow = true;
      if (!item.is_own && UNREAD_KINDS.has(item.content.kind)) hasUnreadBelow = true;
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
  'live_location',
  'poll',
  'unable_to_decrypt',
]);

export function isUnreadMessage(item: TimelineItemView): boolean {
  return item.event_id !== null && !item.is_own && UNREAD_KINDS.has(item.content.kind);
}

export function unreadCountAfter(items: readonly TimelineItemView[], index: number): number {
  let count = 0;
  for (let next = index + 1; next < items.length; next += 1) {
    const item = items[next];
    if (!item.is_own && UNREAD_KINDS.has(item.content.kind)) count += 1;
  }
  return count;
}

export function withReadMarkerBefore(
  items: readonly TimelineItemView[],
  eventId: string
): TimelineItemView[] {
  const rest = items.filter((item) => item.content.kind !== 'read_marker');
  const index = rest.findIndex((item) => item.event_id === eventId);
  if (index < 0) return rest;
  const marker = items.find((item) => item.content.kind === 'read_marker') ?? {
    id: 'unread-marker',
    event_id: null,
    transaction_id: null,
    send_state: null,
    sender: null,
    sender_name: null,
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'read_marker' },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
  };
  return [...rest.slice(0, index), marker, ...rest.slice(index)];
}

export type PersonaLookup = (eventId: string | null | undefined) => PerMessageProfileView | null;

export function personaLookup(
  items: readonly TimelineItemView[],
  unloaded?: PersonaLookup
): PersonaLookup {
  let personas: Map<string, PerMessageProfileView | null> | null = null;

  return (eventId) => {
    if (eventId === null || eventId === undefined) return null;
    if (personas === null) {
      personas = new Map();
      for (const item of items) {
        if (item.event_id) personas.set(item.event_id, item.per_message_profile);
      }
    }

    const loaded = personas.get(eventId);
    return loaded === undefined ? (unloaded?.(eventId) ?? null) : loaded;
  };
}

function personaKey(item: TimelineItemView): string {
  const profile = item.per_message_profile;
  if (!profile) return '';
  return profile.id ?? profile.display_name ?? '';
}

export function isCollapsed(
  items: readonly TimelineItemView[],
  index: number,
  replyPreviewStyle: ReplyPreviewStyle = preferences.replyPreviewStyle
): boolean {
  if (index === 0) return false;
  const current = items[index];
  const previous = items[index - 1];
  if (isEventRow(current) && isEventRow(previous)) return true;
  if (replyPreviewStyle === 'connected' && current.in_reply_to) return false;
  return (
    isMessageRow(current.content) &&
    isMessageRow(previous.content) &&
    current.sender !== null &&
    current.sender === previous.sender &&
    personaKey(current) === personaKey(previous) &&
    current.timestamp - previous.timestamp < 120_000
  );
}

/**
 * Readers whose latest receipt is on this item or a later one. The SDK moves a
 * receipt to its newest event, so an old message otherwise loses its readers.
 */
export function cumulativeReadBy(
  items: readonly TimelineItemView[]
): Map<string, readonly string[]> {
  const readers = new Map<string, readonly string[]>();
  const seen = new Set<string>();
  let cumulative: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const fresh = items[index].read_by.filter((userId) => !seen.has(userId));
    for (const userId of fresh) seen.add(userId);
    if (fresh.length > 0) cumulative = [...fresh, ...cumulative];
    readers.set(items[index].id, cumulative);
  }
  return readers;
}

export function latestEventId(items: readonly TimelineItemView[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const eventId = items[index].event_id;
    if (eventId) return eventId;
  }
  return null;
}

/** Preserve the latest receipt's time, including when it has no timestamp. */
export function cumulativeReadTimestamps(
  items: readonly TimelineItemView[]
): Map<string, Readonly<Record<string, number>>> {
  const timestamps = new Map<string, Readonly<Record<string, number>>>();
  const seen = new Set<string>();
  let cumulative: Record<string, number> = {};
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const fresh = item.read_by.filter((userId) => !seen.has(userId));
    if (fresh.length > 0) {
      cumulative = { ...cumulative };
      for (const userId of fresh) {
        seen.add(userId);
        if (Object.hasOwn(item.read_timestamps, userId)) {
          cumulative[userId] = item.read_timestamps[userId];
        }
      }
    }
    timestamps.set(item.id, cumulative);
  }
  return timestamps;
}

export type ReplyDirection = 'older' | 'newer';

function isReplyTarget(item: TimelineItemView, showHiddenEvents: boolean): boolean {
  if (item.event_id === null || isAnnotation(item) || item.content.kind === 'redacted')
    return false;
  return isMessageRow(item.content) || showHiddenEvents;
}

export function replyTarget(
  items: readonly TimelineItemView[],
  current: string | null,
  direction: ReplyDirection,
  showHiddenEvents: boolean
): string | null {
  const targets = items.filter((item) => isReplyTarget(item, showHiddenEvents));
  const index = current === null ? -1 : targets.findIndex((item) => item.event_id === current);
  if (index < 0) return direction === 'older' ? (targets.at(-1)?.event_id ?? null) : null;
  if (direction === 'newer') return targets[index + 1]?.event_id ?? null;
  return targets[Math.max(0, index - 1)].event_id;
}

export function eventBefore(items: readonly TimelineItemView[], eventId: string): string | null {
  const index = items.findIndex((item) => item.event_id === eventId);
  if (index < 0) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = items[cursor].event_id;
    if (previous) return previous;
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
