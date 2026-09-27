import type { TimelineItemView } from '#src/generated/protocol';

import { canForward, canRedact } from '../timeline/timeline-format';

type DownloadableMedia = Extract<
  TimelineItemView['content'],
  { kind: 'image' | 'video' | 'audio' | 'file' }
>;

export type MessageActionPolicyInput = {
  item: TimelineItemView;
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
  pinned: boolean;
  bookmarked: boolean;
  stealCount: number;
};

export type MessageActionPolicy = {
  eventId: string;
  editId: string;
  body: string | null;
  html: string | null;
  media: DownloadableMedia | null;
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
  pinned,
  bookmarked,
  stealCount,
}: MessageActionPolicyInput): MessageActionPolicy {
  const eventId = item.event_id ?? '';
  const body =
    item.content.kind === 'message'
      ? item.content.body
      : item.content.kind === 'image'
        ? (item.content.caption ?? '')
        : null;
  const media =
    item.content.kind === 'image' ||
    item.content.kind === 'video' ||
    item.content.kind === 'audio' ||
    item.content.kind === 'file'
      ? item.content
      : null;
  const editable =
    item.is_own && (item.content.kind === 'message' || item.content.kind === 'image');
  const hasRoomEvent = roomId !== '' && eventId !== '';
  const threadTarget = item.thread_root ?? item.event_id;

  return {
    eventId,
    editId: item.event_id ?? item.transaction_id ?? '',
    body,
    html: item.content.kind === 'message' ? item.content.html : null,
    media,
    mediaCaption: item.content.kind === 'image',
    threadTarget,
    pinned,
    bookmarked,
    stealCount,
    react: canToggleReaction,
    viewReactions: item.reactions.length > 0,
    readReceipts: true,
    markUnread: canMarkUnread && eventId !== '',
    reply: canReply,
    edit: editable && canEdit && body !== null,
    reproxy: editable && canEdit && item.content.kind === 'message' && eventId !== '',
    redact: canDelete && canRedact(item, canRedactOwn, canRedactOthers),
    copyText: body !== null,
    openThread: canOpenThread && threadTarget !== null,
    copyLink: canCopyLink && item.event_id !== null,
    pin: canPin && hasRoomEvent,
    bookmark: hasRoomEvent,
    forward: hasRoomEvent && canForward(item.content),
    download: media !== null,
    stealEmotes: stealCount > 0,
    editHistory: hasRoomEvent && item.content.kind === 'message' && item.content.edited,
    viewSource: hasRoomEvent,
    report: hasRoomEvent && !item.is_own,
  };
}
