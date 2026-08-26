import type { Component } from 'svelte';

import BookmarkIcon from 'phosphor-svelte/lib/BookmarkSimpleIcon';
import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
import ForwardIcon from 'phosphor-svelte/lib/ShareFatIcon';
import PinIcon from 'phosphor-svelte/lib/PushPinIcon';
import ReportIcon from 'phosphor-svelte/lib/FlagIcon';
import UnpinIcon from 'phosphor-svelte/lib/PushPinSlashIcon';
import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import EmojiIcon from 'phosphor-svelte/lib/SmileyIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import ReceiptIcon from 'phosphor-svelte/lib/EyeIcon';
import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

export type MessageActions = {
  onReact?: (emoji: string) => void;
  onAddReaction?: () => void;
  onViewReactions?: () => void;
  onReadReceipts?: () => void;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopyText?: () => void;
  onCopyLink?: () => void;
  onPin?: () => void;
  onBookmark?: () => void;
  onForward?: () => void;
  onReport?: () => void;
  onViewSource?: () => void;
  pinned?: boolean;
  bookmarked?: boolean;
};

export type MessageMenuRow = {
  key: string;
  label: string;
  icon: Component;
  run: () => void;
  destructive?: boolean;
  separated?: boolean;
};

export function messageMenuRows(actions: MessageActions): MessageMenuRow[] {
  const rows: MessageMenuRow[] = [];

  if (actions.onAddReaction) {
    rows.push({
      key: 'add-reaction',
      label: 'timeline.addReaction',
      icon: EmojiIcon,
      run: actions.onAddReaction,
    });
  }
  if (actions.onReply) {
    rows.push({ key: 'reply', label: 'timeline.reply', icon: ReplyIcon, run: actions.onReply });
  }
  if (actions.onEdit) {
    rows.push({ key: 'edit', label: 'timeline.editMessage', icon: EditIcon, run: actions.onEdit });
  }
  if (actions.onCopyText) {
    rows.push({
      key: 'copy',
      label: 'timeline.copyMessage',
      icon: CopyIcon,
      run: actions.onCopyText,
    });
  }
  if (actions.onCopyLink) {
    rows.push({
      key: 'link',
      label: 'timeline.copyLink',
      icon: LinkIcon,
      run: actions.onCopyLink,
    });
  }
  if (actions.onPin) {
    rows.push({
      key: 'pin',
      label: actions.pinned ? 'timeline.unpinMessage' : 'timeline.pinMessage',
      icon: actions.pinned ? UnpinIcon : PinIcon,
      run: actions.onPin,
    });
  }
  if (actions.onBookmark) {
    rows.push({
      key: 'bookmark',
      label: actions.bookmarked ? 'timeline.unbookmarkMessage' : 'timeline.bookmarkMessage',
      icon: BookmarkIcon,
      run: actions.onBookmark,
    });
  }
  if (actions.onForward) {
    rows.push({
      key: 'forward',
      label: 'timeline.forwardMessage',
      icon: ForwardIcon,
      run: actions.onForward,
    });
  }
  if (actions.onViewReactions) {
    rows.push({
      key: 'reactions',
      label: 'timeline.viewReactions',
      icon: EmojiIcon,
      run: actions.onViewReactions,
    });
  }
  if (actions.onReadReceipts) {
    rows.push({
      key: 'receipts',
      label: 'timeline.readReceipts',
      icon: ReceiptIcon,
      run: actions.onReadReceipts,
    });
  }
  if (actions.onViewSource) {
    rows.push({
      key: 'source',
      label: 'timeline.viewSource',
      icon: CodeIcon,
      run: actions.onViewSource,
    });
  }
  if (actions.onReport) {
    rows.push({
      key: 'report',
      label: 'timeline.reportMessage',
      icon: ReportIcon,
      run: actions.onReport,
      separated: true,
    });
  }
  if (actions.onDelete) {
    rows.push({
      key: 'delete',
      label: 'timeline.deleteMessage',
      icon: TrashIcon,
      run: actions.onDelete,
      destructive: true,
      separated: true,
    });
  }

  return rows;
}
