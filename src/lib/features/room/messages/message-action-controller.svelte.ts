import type { TimelineItemView, ImageSourcePackView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
import { t } from '#lib/i18n.js';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { saveBytes, savesNatively } from '#lib/platform/files.js';
import { favoriteGifs, isFavorite, toggleFavorite } from '#lib/features/gif/favorites.svelte.js';
import { gifFromProxiedMxc } from '#lib/features/gif/providers.js';
import { downloadCandidates, emoteCandidates } from '#lib/features/emotes/steal-emotes.js';
import { pinErrorMessage, type PinnedEvents } from '../timeline/pinned-events.svelte.js';
import type { Bookmarks } from '#lib/rooms/bookmarks.svelte.js';
import type { MessageDialogs } from './message-dialogs.svelte.js';
import type { ReplyVersion } from './reply-preview';
import { messageActionPolicy } from './message-action-policy';

export interface MessageCallbacks {
  onToggleReaction?: (
    eventId: string,
    key: string,
    sourcePack?: ImageSourcePackView | null
  ) => void;
  onMarkUnread?: (eventId: string) => void;
  onReply?: (eventId: string, version?: ReplyVersion) => void;
  onCancelContext?: () => void;
  onEdit?: (eventId: string, body: string, html: string | null, mediaCaption?: boolean) => void;
  onDelete?: (eventId: string, reason: string | null) => void;
  onOpenThread?: (rootEventId: string) => void;
  onCopyLink?: (eventId: string) => void;
}

interface MessageActionContext extends MessageCallbacks {
  item: TimelineItemView;
  roomId: string;
  canPin: boolean;
  canRedactOwn: boolean;
  canRedactOthers: boolean;
  senderTimezone: string | null;
  anchor: HTMLElement | CursorAnchor | null;
  hasLinkPreviews: boolean;
}

interface MessageActionDeps {
  core: CoreClient;
  personaStore: Pick<PersonaStore, 'load'>;
  pinnedEvents: Pick<PinnedEvents, 'has' | 'toggle'>;
  bookmarks: Pick<Bookmarks, 'has' | 'toggle'>;
  dialogs: Pick<MessageDialogs, 'open'>;
}

const SAVE_FEEDBACK_DELAY_MS = 300;

export class MessageActionExecutor {
  savingSource = $state<string | null>(null);
  savingSlow = $state(false);

  constructor(
    private readonly context: () => MessageActionContext,
    private readonly deps: MessageActionDeps
  ) {}

  get actions() {
    const {
      item,
      roomId,
      canPin,
      canRedactOwn,
      canRedactOthers,
      senderTimezone,
      anchor,
      hasLinkPreviews,
      onToggleReaction,
      onMarkUnread,
      onReply,
      onEdit,
      onDelete,
      onOpenThread,
      onCopyLink,
    } = this.context();
    const { core, personaStore, pinnedEvents, bookmarks, dialogs } = this.deps;
    const stealable = emoteCandidates(item.content);
    const pinned = pinnedEvents.has(item.event_id);
    const bookmarked = bookmarks.has(roomId, item.event_id);
    const policy = messageActionPolicy({
      item,
      roomId,
      canPin,
      canRedactOwn,
      canRedactOthers,
      canToggleReaction: onToggleReaction !== undefined,
      canMarkUnread: onMarkUnread !== undefined,
      canReply: onReply !== undefined,
      canEdit: onEdit !== undefined,
      canDelete: onDelete !== undefined,
      canOpenThread: onOpenThread !== undefined,
      canCopyLink: onCopyLink !== undefined,
      hasLinkPreviews,
      pinned,
      bookmarked,
      stealCount: stealable.length,
    });
    const gif =
      item.content.kind === 'image'
        ? gifFromProxiedMxc(
            item.content.source,
            item.content.filename,
            item.content.width,
            item.content.height,
            item.content.size,
            item.content.mime
          )
        : undefined;
    const downloadMedia = async (media: {
      source: string;
      filename: string;
      mime: string | null;
    }): Promise<void> => {
      if (this.savingSource !== null) return;
      this.savingSource = media.source;
      const slow = setTimeout(() => {
        this.savingSlow = true;
      }, SAVE_FEEDBACK_DELAY_MS);
      try {
        const bytes = await core.commands.fetchMedia(media.source, 0, 0).finally(() => {
          clearTimeout(slow);
          this.savingSource = null;
          this.savingSlow = false;
        });
        const outcome = await saveBytes(
          bytes,
          media.filename || 'attachment',
          media.mime ?? 'application/octet-stream'
        );
        if (outcome === 'saved' && savesNatively()) toasts.info(t('viewer.saved'));
        if (outcome === 'failed') toasts.error(t('errors.actionFailed'));
      } catch (error) {
        console.warn('[sable timeline] media download failed', error);
        toasts.error(t('errors.actionFailed'));
      }
    };

    async function downloadEmotes(): Promise<void> {
      try {
        if ((await downloadCandidates(core, stealable)) === 'failed') {
          toasts.error(t('errors.actionFailed'));
        }
      } catch (error) {
        console.warn('[sable timeline] emote download failed', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    async function togglePin(eventId: string): Promise<void> {
      try {
        await pinnedEvents.toggle(roomId, eventId);
      } catch (error) {
        console.warn('[sable timeline] pin failed', error);
        toasts.error(pinErrorMessage(error));
      }
    }

    async function toggleBookmark(eventId: string): Promise<void> {
      try {
        await bookmarks.toggle(roomId, eventId);
      } catch (error) {
        console.warn('[sable timeline] bookmark failed', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    async function openSource(eventId: string): Promise<void> {
      try {
        const source = await core.commands.eventSource(roomId, eventId);
        dialogs.open(item, { kind: 'source', source });
      } catch (error) {
        console.warn('[sable timeline] source unavailable', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    async function openEditHistory(eventId: string): Promise<void> {
      try {
        const versions = await core.commands.editHistory(roomId, eventId);
        dialogs.open(item, { kind: 'edit-history', versions, senderTimezone });
      } catch (error) {
        console.warn('[sable timeline] edit history unavailable', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    async function removeLinkPreviews(eventId: string): Promise<void> {
      try {
        await core.commands.removeLinkPreviews(roomId, eventId, item.thread_root);
      } catch (error) {
        console.warn('[sable timeline] removing link previews failed', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    async function copyText(): Promise<void> {
      if (item.content.kind === 'message') await navigator.clipboard.writeText(item.content.body);
    }
    return {
      loadImagePacks: (targetRoomId: string) => core.commands.imagePacks(targetRoomId),
      roomId,
      onReact: policy.react
        ? (
            emoji: string,
            sourcePack?: import('#src/generated/protocol').ImageSourcePackView | null
          ) => {
            onToggleReaction?.(policy.eventId, emoji, sourcePack);
          }
        : undefined,
      onAddReaction: policy.react
        ? () => {
            dialogs.open(item, { kind: 'react', anchor: anchor });
          }
        : undefined,
      onViewReactions: policy.viewReactions
        ? () => {
            dialogs.open(item, { kind: 'reactions', active: 0 });
          }
        : undefined,
      onReadReceipts: policy.readReceipts
        ? () => {
            dialogs.open(item, { kind: 'receipts' });
          }
        : undefined,
      onMarkUnread: policy.markUnread
        ? () => {
            onMarkUnread?.(policy.eventId);
          }
        : undefined,
      onReply: policy.reply
        ? () => {
            onReply?.(policy.eventId);
          }
        : undefined,
      onEdit: policy.edit
        ? () => {
            if (policy.body === null) return;
            onEdit?.(policy.editId, policy.body, policy.html, policy.mediaCaption);
          }
        : undefined,
      onReproxy: policy.reproxy
        ? () => {
            void personaStore.load();
            dialogs.open(item, { kind: 'reproxy' });
          }
        : undefined,
      onDelete: policy.redact
        ? () => {
            dialogs.open(item, { kind: 'delete', target: policy.eventId });
          }
        : undefined,
      onCopyText: !policy.copyText
        ? undefined
        : () => {
            void copyText();
          },
      onOpenThread: policy.openThread
        ? () => {
            if (policy.threadTarget) onOpenThread?.(policy.threadTarget);
          }
        : undefined,
      onCopyLink: policy.copyLink
        ? () => {
            if (item.event_id) onCopyLink?.(item.event_id);
          }
        : undefined,
      pinned: policy.pinned,
      bookmarked: policy.bookmarked,
      onPin: policy.pin ? () => void togglePin(policy.eventId) : undefined,
      onBookmark: policy.bookmark ? () => void toggleBookmark(policy.eventId) : undefined,
      onRemoveLinkPreviews: policy.removeLinkPreviews
        ? () => void removeLinkPreviews(policy.eventId)
        : undefined,
      onForward: policy.forward
        ? () => {
            dialogs.open(item, { kind: 'forward' });
          }
        : undefined,
      onDownload: policy.download
        ? () => {
            if (policy.media) void downloadMedia(policy.media);
          }
        : undefined,
      gifFavorited: gif !== undefined && isFavorite(favoriteGifs(), gif),
      onFavoriteGif: gif
        ? () => {
            toggleFavorite(gif);
          }
        : undefined,
      stealCount: policy.stealCount,
      onStealEmotes: policy.stealEmotes
        ? () => {
            dialogs.open(item, { kind: 'steal' });
          }
        : undefined,
      onDownloadEmotes: policy.stealEmotes
        ? () => {
            void downloadEmotes();
          }
        : undefined,
      onEditHistory: policy.editHistory ? () => void openEditHistory(policy.eventId) : undefined,
      onViewSource: policy.viewSource ? () => void openSource(policy.eventId) : undefined,
      onReport: policy.report
        ? () => {
            dialogs.open(item, { kind: 'report' });
          }
        : undefined,
    };
  }
}
