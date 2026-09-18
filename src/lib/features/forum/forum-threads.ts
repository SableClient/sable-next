import type { TimelineItemContentView, TimelineItemView } from '#src/generated/protocol';

export interface ForumThread {
  id: string;
  eventId: string;
  sender: string | null;
  senderName: string | null;
  senderAvatar: string | null;
  createdAt: number;
  preview: string;
  replyCount: number;
  lastActivityAt: number;
  lastBody: string | null;
  lastSenderName: string | null;
  unread: boolean;
}

const POST_KINDS = new Set<TimelineItemContentView['kind']>([
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

function bodyOf(content: TimelineItemContentView): string {
  return 'body' in content ? content.body : '';
}

function isPost(item: TimelineItemView): boolean {
  if (item.event_id === null) return false;
  if (item.thread_root !== null && item.thread_root !== item.event_id) return false;
  if (item.in_reply_to !== null) return false;
  return POST_KINDS.has(item.content.kind);
}

function isUnread(latest: TimelineItemView, currentUserId: string | null): boolean {
  if (currentUserId === null) return false;
  if (latest.sender === currentUserId) return false;
  return !latest.read_by.includes(currentUserId);
}

export function collectForumThreads(
  items: readonly TimelineItemView[],
  currentUserId: string | null
): ForumThread[] {
  const roots = new Map<string, TimelineItemView>();
  for (const item of items) {
    if (item.event_id === null) continue;
    if (item.thread_summary !== null || isPost(item)) roots.set(item.event_id, item);
  }

  const latestReplies = new Map<string, TimelineItemView>();
  for (const item of items) {
    const rootId = item.thread_root;
    if (rootId === null || item.event_id === rootId || !roots.has(rootId)) continue;
    const current = latestReplies.get(rootId);
    if (!current || item.timestamp > current.timestamp) latestReplies.set(rootId, item);
  }

  const threads: ForumThread[] = [];
  for (const [rootId, root] of roots) {
    const latestReply = latestReplies.get(rootId) ?? null;
    const latest = latestReply ?? root;
    threads.push({
      id: root.id,
      eventId: rootId,
      sender: root.sender,
      senderName: root.sender_name,
      senderAvatar: root.sender_avatar,
      createdAt: root.timestamp,
      preview: bodyOf(root.content),
      replyCount: root.thread_summary?.num_replies ?? 0,
      lastActivityAt: latest.timestamp,
      lastBody:
        root.thread_summary?.latest_body ?? (latestReply ? bodyOf(latestReply.content) : null),
      lastSenderName: latestReply?.sender_name ?? latestReply?.sender ?? null,
      unread: isUnread(latest, currentUserId),
    });
  }

  return threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
