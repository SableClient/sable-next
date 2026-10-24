import type { ResolvedItem, ResolvedRow } from '#lib/rooms/timeline-item.js';
import type {
  PerMessageProfileView,
  TimelineItemContentView,
  TimelineGroupInput,
} from '#src/generated/protocol';

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
      | 'redacted'
      | 'unable_to_decrypt';
  }
>;

export type MessageItem = ResolvedItem & { content: MessageContent };

/** Rows that carry a sender, a hover menu and reactions. */
export function isMessageRow(item: ResolvedItem): item is MessageItem {
  return item.row === 'message';
}

export function canRedact(
  item: ResolvedItem,
  canRedactOwn: boolean,
  canRedactOthers: boolean
): boolean {
  return item.redactable && (item.is_own ? canRedactOwn : canRedactOthers);
}

export function isAnnotation(item: ResolvedItem): boolean {
  return item.row === 'annotation';
}

export function isEventRow(item: ResolvedItem): boolean {
  return item.row === 'event';
}

export type PersonaLookup = (eventId: string | null | undefined) => PerMessageProfileView | null;

export function personaLookup(
  items: readonly ResolvedItem[],
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

/** The facts the runtime's grouping rule reads, for a message shown outside a timeline. */
export function groupInput(item: ResolvedItem): TimelineGroupInput {
  const profile = item.per_message_profile;
  return {
    row: item.row,
    sender: item.sender,
    timestamp: item.timestamp,
    reply: item.in_reply_to !== null,
    profile: profile
      ? { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url }
      : null,
  };
}

export type ReplyDirection = 'older' | 'newer';

/** The event a reply step lands on, from the rows the runtime marks as eligible. */
export function replyTarget(
  rows: readonly ResolvedRow[],
  current: string | null,
  direction: ReplyDirection
): string | null {
  const targets = rows
    .flatMap((row) => row.group ?? [row])
    .filter((entry) => entry.reply_target)
    .map((entry) => entry.item.event_id);
  const index = current === null ? -1 : targets.indexOf(current);
  if (index < 0) return direction === 'older' ? (targets.at(-1) ?? null) : null;
  if (direction === 'newer') return targets[index + 1] ?? null;
  return targets[Math.max(0, index - 1)];
}

/**
 * The newest event scrolled past, so history loading below the reader never moves the receipt back.
 */
export function readReceiptEventId(
  items: readonly ResolvedItem[],
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
