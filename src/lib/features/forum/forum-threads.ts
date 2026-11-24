import type {
  GalleryItemView,
  ReactionGroup,
  TimelineItemContentView,
  TimelineItemView,
} from '#src/generated/protocol';
import { isMediaCaptionContent } from '#lib/features/room/messages/media-caption.js';
import { senderDisplayName } from '#lib/personas/persona.js';

export type ForumSort = 'active' | 'created' | 'votes';
export type ForumLayout = 'list' | 'gallery';

export interface ForumView {
  sort: ForumSort;
  layout: ForumLayout;
}

export interface ForumThumbnail {
  source: string;
  thumbnail: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  video: boolean;
  spoiler: boolean;
}

export interface ForumThread {
  id: string;
  item: TimelineItemView;
  eventId: string;
  title: string | null;
  sender: string | null;
  senderName: string | null;
  senderAvatar: string | null;
  isOwn: boolean;
  editable: boolean;
  html: string | null;
  mediaCaption: boolean;
  createdAt: number;
  preview: string;
  thumbnail: ForumThumbnail | null;
  replyCount: number;
  lastActivityAt: number;
  lastBody: string | null;
  lastSenderName: string | null;
  unread: boolean;
  votes: number;
  /** The thumbs-up variant the user voted with, which is the one to take back. */
  ownVote: string | null;
  resolved: boolean;
}

export const MAX_PINNED = 3;

export const VOTE = '👍';
const RESOLVED = '✅';

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
  if ('body' in content) return content.body;
  if (isMediaCaptionContent(content)) return content.caption ?? '';
  return '';
}

function htmlOf(content: TimelineItemContentView): string | null {
  if (content.kind === 'message') return content.html;
  if (isMediaCaptionContent(content)) return content.html;
  return null;
}

type Visual = Extract<TimelineItemContentView | GalleryItemView, { kind: 'image' | 'video' }>;

function thumbnailOf(content: TimelineItemContentView): ForumThumbnail | null {
  const visual: Visual | undefined =
    content.kind === 'gallery'
      ? content.items.find((item) => item.kind === 'image' || item.kind === 'video')
      : content.kind === 'image' || content.kind === 'video'
        ? content
        : undefined;
  if (!visual) return null;
  const video = visual.kind === 'video';
  const source = video ? visual.thumbnail : visual.source;
  if (source === null) return null;
  return {
    source,
    thumbnail: video ? null : visual.thumbnail,
    width: visual.width,
    height: visual.height,
    blurhash: visual.blurhash,
    video,
    spoiler: visual.spoiler !== null,
  };
}

function isPost(item: TimelineItemView): boolean {
  if (item.event_id === null) return false;
  if (item.thread_root !== null && item.thread_root !== item.event_id) return false;
  if (item.in_reply_to !== null) return false;
  return POST_KINDS.has(item.content.kind);
}

function countVotes(reactions: readonly ReactionGroup[]): number {
  const voters = new Set<string>();
  for (const group of reactions) {
    if (!group.key.startsWith(VOTE)) continue;
    for (const sender of group.senders) voters.add(sender);
  }
  return voters.size;
}

function ownVote(reactions: readonly ReactionGroup[], currentUserId: string | null): string | null {
  if (currentUserId === null) return null;
  return (
    reactions.find((group) => group.key.startsWith(VOTE) && group.senders.includes(currentUserId))
      ?.key ?? null
  );
}

function isResolved(reactions: readonly ReactionGroup[], author: string | null): boolean {
  return (
    author !== null &&
    reactions.some((group) => group.key === RESOLVED && group.senders.includes(author))
  );
}

export function sortThreads(threads: readonly ForumThread[], sort: ForumSort): ForumThread[] {
  if (sort === 'active') return threads.slice();
  if (sort === 'created') return threads.slice().sort((a, b) => b.createdAt - a.createdAt);
  return threads
    .slice()
    .sort(
      (a, b) =>
        Number(a.resolved) - Number(b.resolved) ||
        b.votes - a.votes ||
        b.lastActivityAt - a.lastActivityAt
    );
}

export function filterThreads(threads: readonly ForumThread[], query: string): ForumThread[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return threads.slice();
  return threads.filter((thread) =>
    [thread.title, thread.preview, thread.senderName].some((text) =>
      text?.toLowerCase().includes(needle)
    )
  );
}

function isUnread(latest: TimelineItemView, currentUserId: string | null): boolean {
  if (currentUserId === null) return false;
  if (latest.sender === currentUserId) return false;
  return !latest.read_by.includes(currentUserId);
}

export function collectForumThreads(
  items: readonly TimelineItemView[],
  currentUserId: string | null,
  latestEvents: readonly TimelineItemView[] = [],
  unreadByRoot: ReadonlyMap<string, boolean> = new Map(),
  listedReactions: ReadonlyMap<string, readonly ReactionGroup[]> = new Map()
): ForumThread[] {
  const roots = new Map<string, TimelineItemView>();
  const redacted = new Set(
    [...items, ...latestEvents]
      .filter((item) => item.content.kind === 'redacted')
      .map((item) => item.event_id)
  );
  // Roots listed by the server carry no reactions: `listedReactions` has theirs, and the
  // timeline's are newer.
  const reactions = new Map(listedReactions);
  for (const item of items) {
    if (item.event_id === null || redacted.has(item.event_id)) continue;
    if (item.reactions.length > 0) reactions.set(item.event_id, item.reactions);
    if (item.thread_summary !== null || isPost(item)) roots.set(item.event_id, item);
  }

  const latestReplies = new Map<string, TimelineItemView>();
  for (const item of [...items, ...latestEvents]) {
    const rootId = item.thread_root;
    if (rootId === null || item.event_id === rootId || !roots.has(rootId)) continue;
    if (redacted.has(item.event_id)) continue;
    const current = latestReplies.get(rootId);
    if (!current || item.timestamp > current.timestamp) latestReplies.set(rootId, item);
  }

  const threads: ForumThread[] = [];
  for (const [rootId, root] of roots) {
    const candidate = latestReplies.get(rootId) ?? null;
    const summaryLatestId = root.thread_summary?.latest_event_id ?? null;
    const summaryLatestRedacted = summaryLatestId !== null && redacted.has(summaryLatestId);
    const latestReply =
      candidate &&
      (!summaryLatestId || candidate.event_id === summaryLatestId || summaryLatestRedacted)
        ? candidate
        : null;
    const latest = latestReply ?? root;
    const rootReactions = reactions.get(rootId) ?? [];
    threads.push({
      id: root.id,
      item: root,
      eventId: rootId,
      title: root.forum_title,
      sender: root.sender,
      senderName: senderDisplayName(root),
      senderAvatar: root.sender_avatar,
      isOwn: root.is_own,
      editable:
        root.is_own && (root.content.kind === 'message' || isMediaCaptionContent(root.content)),
      html: htmlOf(root.content),
      mediaCaption: isMediaCaptionContent(root.content),
      createdAt: root.timestamp,
      preview: bodyOf(root.content),
      thumbnail: thumbnailOf(root.content),
      replyCount: root.thread_summary?.num_replies ?? 0,
      lastActivityAt: latest.timestamp,
      lastBody:
        (summaryLatestRedacted ? null : root.thread_summary?.latest_body) ??
        (latestReply ? bodyOf(latestReply.content) : null),
      lastSenderName: latestReply ? senderDisplayName(latestReply) : null,
      unread: unreadByRoot.get(rootId) ?? isUnread(latest, currentUserId),
      votes: countVotes(rootReactions),
      ownVote: ownVote(rootReactions, currentUserId),
      resolved: isResolved(rootReactions, root.sender),
    });
  }

  return threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
