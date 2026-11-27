import { copyText as writeClipboard } from '#lib/platform/clipboard.js';
import type {
  TimelineItemView,
  ImageSourcePackView,
  UrlPreviewView,
} from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
import { t } from '#lib/i18n.js';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { saveBytes, saveVideoToPhotos } from '#lib/platform/files.js';
import { confirmSaved, reportSave } from '#lib/ui/download.js';
import { favoriteGifs, isFavorite, toggleFavorite } from '#lib/gif/favorites.svelte.js';
import { isNativeMobile, isAndroid } from '#lib/platform/os.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { gifFromProxiedMxc, gifFromUploadedMxc } from '#lib/gif/providers.js';
import { downloadCandidates, emoteCandidates } from '#lib/features/emotes/steal-emotes.js';
import { previewGif } from '../media/link-preview.js';
import { pinErrorMessage, type PinnedEvents } from '../timeline/pinned-events.svelte.js';
import type { Bookmarks } from '#lib/rooms/bookmarks.svelte.js';
import { meowlnirFor } from '#lib/rooms/meowlnir-registry.svelte.js';
import { serverFeatures } from '#lib/core/server-features.svelte.js';
import { isCoreError } from '#src/transport';
import type { MessageDialogs } from './message-dialogs.svelte.js';
import type { ReplyVersion } from './reply-preview';
import { messageActionPolicy } from './message-action-policy';
import {
  hideContent,
  revealState,
  setRevealState,
  type RevealState,
} from './revealed-redactions.svelte.js';

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
  onCopyLink?: (eventId: string, format?: 'matrix' | 'external') => void;
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
  linkPreviews: readonly UrlPreviewView[];
}

interface MessageActionDeps {
  core: CoreClient;
  personaStore: Pick<PersonaStore, 'load'>;
  pinnedEvents: Pick<PinnedEvents, 'has' | 'toggle'>;
  bookmarks: Pick<Bookmarks, 'has' | 'toggle'>;
  dialogs: Pick<MessageDialogs, 'open'>;
  isDirect: (roomId: string) => boolean;
}

const SAVE_FEEDBACK_DELAY_MS = 300;
const MSC2815 = 'fi.mau.msc2815';
const DAY_MS = 86_400_000;

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
      linkPreviews,
      onToggleReaction,
      onMarkUnread,
      onReply,
      onEdit,
      onDelete,
      onOpenThread,
      onCopyLink,
    } = this.context();
    const { core, personaStore, pinnedEvents, bookmarks, dialogs, isDirect } = this.deps;
    const stealable = emoteCandidates(item.content);
    const pinned = pinnedEvents.has(item.event_id);
    const bookmarked = bookmarks.has(roomId, item.event_id);
    const policy = messageActionPolicy({
      item,
      roomId,
      canPin,
      canRedactOwn,
      canRedactOthers,
      canViewRedacted:
        item.content.kind === 'redacted' &&
        ((canRedactOthers && item.redacted_on_ban === true) ||
          (((canRedactOthers && !isDirect(roomId)) || preferences.developerTools) &&
            serverFeatures(core).includes(MSC2815))),
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
    const linkGif = policy.media === null ? previewGif(linkPreviews) : null;
    const gif =
      item.content.kind === 'image'
        ? (gifFromProxiedMxc(
            item.content.source,
            item.content.filename,
            item.content.width,
            item.content.height,
            item.content.size,
            item.content.mime
          ) ??
          gifFromUploadedMxc(
            item.content.source,
            item.content.filename,
            item.content.width,
            item.content.height,
            item.content.size,
            item.content.mime,
            item.content.animated
          ))
        : linkGif?.favorite;
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
        const bytes = await core.media.fetchMedia(media.source, 0, 0).finally(() => {
          clearTimeout(slow);
          this.savingSource = null;
          this.savingSlow = false;
        });
        const outcome = await saveBytes(
          bytes,
          media.filename || 'attachment',
          media.mime ?? 'application/octet-stream',
          preferences.askDownloadLocation
        );
        reportSave(outcome);
      } catch (error) {
        console.warn('[sable timeline] media download failed', error);
        toasts.error(t('errors.actionFailed'));
      }
    };

    const saveVideoToLibrary = async (): Promise<void> => {
      if (!policy.media || this.savingSource !== null) return;
      this.savingSource = policy.media.source;
      const slow = setTimeout(() => {
        this.savingSlow = true;
      }, SAVE_FEEDBACK_DELAY_MS);
      try {
        const bytes = await core.media.fetchMedia(policy.media.source, 0, 0);
        const url = URL.createObjectURL(new Blob([bytes], { type: policy.media.mime ?? '' }));
        try {
          const outcome = await saveVideoToPhotos(
            url,
            policy.media.filename || 'video',
            policy.media.mime ?? undefined
          );
          if (outcome === 'saved') toasts.info(t('viewer.saved'));
          if (outcome === 'failed') toasts.error(t('errors.actionFailed'));
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        console.warn('[sable timeline] save to photos failed', error);
        toasts.error(t('errors.actionFailed'));
      } finally {
        clearTimeout(slow);
        this.savingSource = null;
        this.savingSlow = false;
      }
    };

    async function downloadEmotes(): Promise<void> {
      try {
        const outcome = await downloadCandidates(core, stealable);
        if (outcome === 'failed') toasts.error(t('errors.actionFailed'));
        if (outcome === 'saved') confirmSaved();
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
        const { source, encrypted, original, encryption } = await core.rpc.timeline.eventSource({
          room_id: roomId,
          event_id: eventId,
          include_original: true,
        });
        dialogs.open(item, { kind: 'source', source, encrypted, original, encryption });
      } catch (error) {
        console.warn('[sable timeline] source unavailable', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    const reveal = revealState(roomId, item.event_id);
    const redactedRevealed = reveal?.kind === 'shown';

    async function toggleRedacted(eventId: string): Promise<void> {
      if (reveal?.kind === 'loading') return;
      if (redactedRevealed) {
        hideContent(roomId, eventId);
        return;
      }
      setRevealState(roomId, eventId, { kind: 'loading' });
      setRevealState(roomId, eventId, await unredacted(eventId));
    }

    async function unredacted(eventId: string): Promise<RevealState> {
      const failed = (message: string): RevealState => ({ kind: 'failed', message });
      try {
        const found = await core.rpc.timeline.unredactedEvent({
          room_id: roomId,
          event_id: eventId,
        });
        switch (found.kind) {
          case 'content':
            return { kind: 'shown', content: found.content };
          case 'undecryptable':
            return failed(t('timeline.redactedUndecryptable'));
          case 'deleted':
            return failed(
              found.content_keep_ms === null
                ? t('timeline.redactedErased')
                : t('timeline.redactedErasedAfter', {
                    count: Math.max(1, Math.round(found.content_keep_ms / DAY_MS)),
                  })
            );
          case 'not_received':
            return failed(t('timeline.redactedNotReceived'));
        }
      } catch (error) {
        console.warn('[sable timeline] redacted content unavailable', error);
        return failed(
          isCoreError(error, 'denied') ? t('timeline.redactedDenied') : t('errors.actionFailed')
        );
      }
    }

    async function openEditHistory(eventId: string): Promise<void> {
      try {
        const versions = await core.rpc.timeline.editHistory({
          room_id: roomId,
          event_id: eventId,
        });
        dialogs.open(item, { kind: 'edit-history', versions, senderTimezone });
      } catch (error) {
        console.warn('[sable timeline] edit history unavailable', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    async function removeLinkPreviews(eventId: string): Promise<void> {
      try {
        await core.rpc.messages.removeLinkPreviews({
          room_id: roomId,
          event_id: eventId,
          thread_root: item.thread_root,
        });
      } catch (error) {
        console.warn('[sable timeline] removing link previews failed', error);
        toasts.error(t('errors.actionFailed'));
      }
    }

    async function copyText(): Promise<void> {
      if (!policy.body) return;
      try {
        await writeClipboard(policy.body);
        toasts.info(t('common.copied'));
      } catch (error) {
        console.debug('[sable timeline] copy message failed', error);
        toasts.error(t('errors.actionFailed'));
      }
    }
    return {
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
            dialogs.open(item, { kind: 'reactions' });
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
      onCopyMatrixLink: policy.copyLink
        ? () => {
            if (item.event_id) onCopyLink?.(item.event_id, 'matrix');
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
        : linkGif
          ? () => void downloadMedia(linkGif.media)
          : undefined,
      onSaveToPhotos:
        item.content.kind === 'video' && isNativeMobile() && !isAndroid()
          ? () => void saveVideoToLibrary()
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
      redactedRevealed,
      onViewRedacted: policy.viewRedacted ? () => void toggleRedacted(policy.eventId) : undefined,
      onReport: policy.report
        ? () => {
            dialogs.open(item, { kind: 'report' });
          }
        : undefined,
      onMeowlnirBan:
        !item.is_own && item.sender && meowlnirFor(roomId, core.session?.user_id)
          ? () => {
              dialogs.open(item, { kind: 'meowlnir-ban' });
            }
          : undefined,
    };
  }
}
