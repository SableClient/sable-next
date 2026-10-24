import type {
  ReactionGroup,
  TimelineGroupMemberView,
  TimelineItemContentView,
  TimelineItemView,
  TimelineReceiptsView,
  TimelineRowView,
  TimelineSegmentView,
} from '#src/generated/protocol';

/** What the wire leaves off an item when it is null, empty or the default. */
const ABSENT_ITEM = {
  forwardable: false,
  redactable: false,
  visibility: 'always',
  event_id: null,
  transaction_id: null,
  send_state: null,
  sender: null,
  sender_name: null,
  sender_avatar: null,
  in_reply_to: null,
  thread_root: null,
  thread_summary: null,
  reactions: [] as ReactionGroup[],
  is_own: false,
  read_by: [] as string[],
  read_timestamps: {} as Record<string, number>,
  per_message_profile: null,
  bundled_link_previews: [],
  link_previews_removed: null,
  mention: 'none',
  forwarded: null,
  forum_title: null,
} as const;

type Absent = typeof ABSENT_ITEM;

type MessageContent = Extract<TimelineItemContentView, { kind: 'message' }>;

export type ResolvedContent =
  | Exclude<TimelineItemContentView, { kind: 'message' }>
  | (Required<Omit<MessageContent, 'jumbo'>> & Pick<MessageContent, 'jumbo'>);

/** An item with every field present. */
export type ResolvedItem = Omit<TimelineItemView, 'content' | keyof Absent> & {
  content: ResolvedContent;
} & {
  -readonly [K in keyof Absent]-?: Absent[K] extends null
    ? NonNullable<TimelineItemView[K]> | null
    : NonNullable<TimelineItemView[K]>;
};

export interface ResolvedReceipts {
  readers: string[];
  timestamps: Record<string, number>;
}

export interface ResolvedGroupMember {
  reply_target: boolean;
  item: ResolvedItem;
}

/** A row with every field present, and `receipts` naming everyone who has read that far. */
export interface ResolvedRow {
  key: string;
  reply_target: boolean;
  item: ResolvedItem;
  group: ResolvedGroupMember[] | null;
  segments: TimelineSegmentView[];
  collapsed: boolean;
  group_start: boolean;
  unread_count: number;
  receipts: ResolvedReceipts | null;
}

function resolveContent(content: TimelineItemContentView): ResolvedContent {
  if (content.kind !== 'message') return content;
  return { emote: false, notice: false, edited: false, ...content };
}

const items = new WeakMap<TimelineItemView, ResolvedItem>();

/** The same object for the same wire item, so an item a patch left alone keeps its identity. */
export function resolveItem(wire: TimelineItemView): ResolvedItem {
  let item = items.get(wire);
  if (item === undefined) {
    item = { ...ABSENT_ITEM, ...wire, content: resolveContent(wire.content) } as ResolvedItem;
    items.set(wire, item);
  }
  return item;
}

function resolveReceipts(
  item: ResolvedItem,
  later: TimelineReceiptsView | undefined
): ResolvedReceipts | null {
  const readers = [...item.read_by, ...(later?.readers ?? [])];
  if (readers.length === 0) return null;
  return { readers, timestamps: { ...item.read_timestamps, ...later?.timestamps } };
}

const rows = new WeakMap<TimelineRowView, ResolvedRow>();

export function resolveRow(wire: TimelineRowView): ResolvedRow {
  let row = rows.get(wire);
  if (row === undefined) {
    const item = resolveItem(wire.item);
    row = {
      key: wire.key,
      reply_target: wire.reply_target,
      item,
      group: wire.group?.map(resolveMember) ?? null,
      segments: wire.segments ?? [],
      collapsed: wire.collapsed ?? false,
      group_start: wire.group_start ?? false,
      unread_count: wire.unread_count ?? 0,
      receipts: resolveReceipts(item, wire.later_receipts),
    };
    rows.set(wire, row);
  }
  return row;
}

function resolveMember(member: TimelineGroupMemberView): ResolvedGroupMember {
  return { reply_target: member.reply_target, item: resolveItem(member.item) };
}
