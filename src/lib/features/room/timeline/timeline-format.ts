import type {
  PerMessageProfileView,
  TimelineItemContentView,
  TimelineItemView,
} from '#src/generated/protocol';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { ReplyPreviewStyle, TimelinePreferences } from '#lib/settings/preferences.svelte.js';

export { senderColor } from '#lib/ui/primitives/identity-color.js';

export type MessageContent = Extract<
  TimelineItemContentView,
  {
    kind:
      | 'message'
      | 'image'
      | 'video'
      | 'audio'
      | 'file'
      | 'sticker'
      | 'gallery'
      | 'location'
      | 'live_location'
      | 'poll'
      | 'redacted';
  }
>;

export type MessageItem = TimelineItemView & { content: MessageContent };

/** Rows that carry a sender, a hover menu and reactions. */
export function isMessageRow(item: TimelineItemView): item is MessageItem {
  return item.row === 'message';
}

export function canRedact(
  item: TimelineItemView,
  canRedactOwn: boolean,
  canRedactOthers: boolean
): boolean {
  return item.redactable && (item.is_own ? canRedactOwn : canRedactOthers);
}

export function isAnnotation(item: TimelineItemView): boolean {
  return item.row === 'annotation';
}

export function isEventRow(item: TimelineItemView): boolean {
  return item.row === 'event';
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
  switch (item.visibility) {
    case 'membership':
      return !preferences.hideMembershipEvents && !memberEventsHidden;
    case 'membership_other':
      return (
        !preferences.hideMembershipEvents && !memberEventsHidden && preferences.showHiddenEvents
      );
    case 'profile_change':
      return !preferences.hideProfileChanges && !memberEventsHidden;
    case 'tombstone':
      return preferences.showTombstoneEvents;
    case 'hidden':
      return preferences.showHiddenEvents && preferences.hiddenEventOther;
    case 'always':
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
    const dateDivider = item.content.kind === 'date_divider';
    const boundary = dateDivider ? new Date(item.timestamp).setHours(0, 0, 0, 0) : item.timestamp;
    while (
      next < pending.length &&
      (dateDivider ? pending[next].timestamp < boundary : pending[next].timestamp <= boundary)
    ) {
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
    row: 'annotation',
    forwardable: false,
    redactable: false,
    visibility: 'always',
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
    forum_title: null,
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
    isMessageRow(current) &&
    isMessageRow(previous) &&
    current.sender !== null &&
    current.sender === previous.sender &&
    personaKey(current) === personaKey(previous) &&
    Math.abs(current.timestamp - previous.timestamp) < 120_000
  );
}

/**
 * Readers whose latest receipt is on this item or a later one.
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
  return isMessageRow(item) || showHiddenEvents;
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
 * The newest event scrolled past, so history loading below the reader never moves the receipt back.
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
