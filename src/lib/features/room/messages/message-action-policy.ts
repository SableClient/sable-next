import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { isRecord } from '#lib/guards.js';

import { canRedact } from '../timeline/timeline-format';
import { isMediaCaptionContent, type MediaCaptionContent } from './media-caption';

export type MessageActionPolicyInput = {
  item: ResolvedItem;
  roomId: string;
  canPin: boolean;
  canRedactOwn: boolean;
  canRedactOthers: boolean;
  canToggleReaction: boolean;
  canMarkUnread: boolean;
  canReply: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canOpenThread: boolean;
  canCopyLink: boolean;
  hasLinkPreviews: boolean;
  pinned: boolean;
  bookmarked: boolean;
  stealCount: number;
};

export type MessageActionPolicy = {
  eventId: string;
  editId: string;
  body: string | null;
  html: string | null;
  media: MediaCaptionContent | null;
  mediaCaption: boolean;
  threadTarget: string | null;
  pinned: boolean;
  bookmarked: boolean;
  stealCount: number;
  react: boolean;
  viewReactions: boolean;
  readReceipts: boolean;
  markUnread: boolean;
  reply: boolean;
  edit: boolean;
  reproxy: boolean;
  redact: boolean;
  copyText: boolean;
  openThread: boolean;
  copyLink: boolean;
  removeLinkPreviews: boolean;
  pin: boolean;
  bookmark: boolean;
  forward: boolean;
  download: boolean;
  stealEmotes: boolean;
  editHistory: boolean;
  viewSource: boolean;
  report: boolean;
};

export function messageActionPolicy({
  item,
  roomId,
  canPin,
  canRedactOwn,
  canRedactOthers,
  canToggleReaction,
  canMarkUnread,
  canReply,
  canEdit,
  canDelete,
  canOpenThread,
  canCopyLink,
  hasLinkPreviews,
  pinned,
  bookmarked,
  stealCount,
}: MessageActionPolicyInput): MessageActionPolicy {
  const eventId = item.event_id ?? '';
  const media = isMediaCaptionContent(item.content) ? item.content : null;
  const body =
    item.content.kind === 'message'
      ? item.content.body
      : media !== null
        ? (media.caption ?? '')
        : null;
  const editable =
    item.is_own && item.forwarded === null && (item.content.kind === 'message' || media !== null);
  const hasRoomEvent = roomId !== '' && eventId !== '';
  const threadTarget = item.thread_root ?? item.event_id;
  const rawContent = item.content.kind === 'hidden_event' ? item.content.content : null;
  const relation = isRecord(rawContent) ? rawContent['m.relates_to'] : null;
  const canAnnotate =
    !isRecord(relation) ||
    (relation.rel_type !== 'm.annotation' && relation.rel_type !== 'm.replace');
  const redacted = item.content.kind === 'redacted';

  return {
    eventId,
    editId: item.event_id ?? item.transaction_id ?? '',
    body,
    html: item.content.kind === 'message' ? item.content.html : (media?.html ?? null),
    media,
    mediaCaption: media !== null,
    threadTarget,
    pinned,
    bookmarked,
    stealCount,
    react: canToggleReaction && canAnnotate && !redacted,
    viewReactions: canAnnotate && !redacted && item.reactions.length > 0,
    readReceipts: true,
    markUnread: canMarkUnread && eventId !== '',
    reply: canReply,
    edit: editable && canEdit && body !== null,
    reproxy:
      item.is_own &&
      canEdit &&
      eventId !== '' &&
      (item.content.kind === 'message' ||
        item.content.kind === 'gallery' ||
        item.content.kind === 'location' ||
        media !== null),
    redact: canDelete && canRedact(item, canRedactOwn, canRedactOthers),
    copyText: body !== null,
    openThread: canOpenThread && threadTarget !== null,
    copyLink: canCopyLink && item.event_id !== null,
    removeLinkPreviews:
      hasRoomEvent &&
      item.is_own &&
      item.content.kind === 'message' &&
      hasLinkPreviews &&
      item.link_previews_removed !== true,
    pin: canPin && hasRoomEvent,
    bookmark: hasRoomEvent,
    forward: hasRoomEvent && item.forwardable,
    download: media !== null,
    stealEmotes: stealCount > 0,
    editHistory: hasRoomEvent && item.content.kind === 'message' && item.content.edited,
    viewSource: hasRoomEvent,
    report: hasRoomEvent && !item.is_own,
  };
}
