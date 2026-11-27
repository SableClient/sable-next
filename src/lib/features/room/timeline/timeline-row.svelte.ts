import { onDestroy, type Snippet } from 'svelte';
import { on } from 'svelte/events';

import type {
  MemberView,
  PerMessageProfileView,
  TimelineItemView,
  UrlPreviewView,
} from '#src/generated/protocol';

import { copyText } from '#lib/platform/clipboard.js';
import { shareLink, sharesLinks } from '#lib/platform/files.js';
import { i18n } from '#lib/i18n.js';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { useCoreClient } from '#lib/core/context.js';
import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
import { LongPress, touchContextMenu } from '#lib/ui/long-press.svelte.js';
import { DoubleTap } from '#lib/ui/double-tap.js';
import { hapticFeedback } from '#lib/platform/haptics.js';
import { usePersonaStore } from '#lib/personas/personas.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { type TimelineLayout } from '#lib/settings/definitions.js';
import { useBookmarks } from '#lib/rooms/bookmarks.svelte.js';
import { useRoomCosmetics, type SenderCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
import { matrixLinkDestination, parseMatrixLink, type MatrixLink } from '#lib/rooms/matrix-link.js';
import { useRoomList } from '#lib/rooms/room-list.svelte.js';

import { useSenderColors } from '../members/members.js';
import { hasSenderRoles, useSenderRoles } from '../members/sender-roles.js';
import { MessageSwipe } from '../messages/message-swipe.svelte.js';
import { useMessageMenu } from '../messages/message-menu-open.svelte.js';
import { hasMessageSelection, useMessageSelection } from '../messages/message-selection.svelte.js';
import type { MessageActions } from '../messages/message-menu-items';
import { useMessageDialogs } from '../messages/message-dialogs.svelte.js';
import {
  MessageActionExecutor,
  type MessageCallbacks,
} from '../messages/message-action-controller.svelte.js';
import { usePinnedEvents } from './pinned-events.svelte.js';
import type { TimelineEventIndex } from './timeline-event-index';
import { TimelineItemProfiles } from './timeline-item-profiles.svelte';
import { TimelineItemEngagement } from './timeline-item-engagement.svelte';
import { selectedText, withSelectedText } from './timeline-item-selection';

export interface TimelineCallbacks extends MessageCallbacks {
  onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  onSenderProfile?: (
    userId: string,
    anchor: HTMLElement,
    pmp?: PerMessageProfileView | null
  ) => void;
  onMentionUser?: (userId: string, name: string) => void;
  onRetrySend?: (transactionId: string) => void;
  onCancelSend?: (transactionId: string) => void;
  onOpenMedia?: (eventId: string) => void;
  onVotePoll?: (eventId: string, answers: string[]) => void;
  onEndPoll?: (eventId: string) => void;
  onSwipeMembers?: () => void;
}

export interface TimelineItemProps extends TimelineCallbacks {
  item: TimelineItemView;
  collapsed: boolean;
  unreadCount?: number;
  replyPersona?: PerMessageProfileView | null;
  threadPersona?: PerMessageProfileView | null;
  roomId?: string;
  highlighted?: boolean;
  currentUserId?: string | null;
  canRedactOwn?: boolean;
  canRedactOthers?: boolean;
  canPin?: boolean;
  encrypted?: boolean | null;
  selected?: boolean;
  editing?: boolean;
  editor?: Snippet;
  layout?: TimelineLayout;
  preview?: boolean;
  loadPreviewProfile?: boolean;
  timeAction?: { label: string; run: () => void };
  headerAction?: Snippet;
  alignOwn?: boolean;
  avatarsInHeaders?: boolean;
  members?: readonly MemberView[];
  onJumpToEvent?: (eventId: string) => void;
  events?: TimelineEventIndex;
  onMenuOpenChange?: (open: boolean) => void;
  placeholder?: boolean;
  placeholderCharacters?: number;
  overrideCosmetics?: SenderCosmetics | null;
}

export interface TimelineRowOptions extends MessageCallbacks {
  item: TimelineItemView;
  roomId: string;
  canPin: boolean;
  canRedactOwn: boolean;
  canRedactOthers: boolean;
  preview: boolean;
  loadPreviewProfile: boolean;
  selected: boolean;
  editing: boolean;
  overrideCosmetics: SenderCosmetics | null;
  replySender: string | null;
  hasLinkPreviews: boolean;
  linkPreviews: readonly UrlPreviewView[];
  onMenuOpenChange?: (open: boolean) => void;
  onSwipeMembers?: () => void;
  onCancelSend?: (transactionId: string) => void;
}

export class TimelineRow {
  element = $state<HTMLElement | null>(null);
  #anchor = $state.raw<CursorAnchor | null>(null);
  actionsPinned = $state(false);

  readonly core = useCoreClient();
  readonly dialogs = useMessageDialogs();
  readonly menu = useMessageMenu();
  readonly selection = hasMessageSelection() ? useMessageSelection() : null;
  readonly profiles = new TimelineItemProfiles(this.core);
  readonly engagement = new TimelineItemEngagement(() => this.element);
  readonly actionExecutor: MessageActionExecutor;
  readonly swipe: MessageSwipe;
  readonly press: LongPress;
  readonly #doubleTap: DoubleTap;
  readonly #roomCosmetics = useRoomCosmetics();
  readonly #roomList = useRoomList();
  readonly #senderRoles = hasSenderRoles() ? useSenderRoles() : null;
  readonly #senderColors = useSenderColors();
  readonly #options: () => TimelineRowOptions;

  constructor(options: () => TimelineRowOptions) {
    this.#options = options;
    this.actionExecutor = new MessageActionExecutor(
      () => {
        const options = this.#options();
        return {
          ...options,
          senderTimezone: this.senderTimezone,
          anchor: this.#anchor ?? this.element,
          onEdit: options.item.forwarded ? undefined : options.onEdit,
        };
      },
      {
        core: this.core,
        personaStore: usePersonaStore(),
        pinnedEvents: usePinnedEvents(),
        bookmarks: useBookmarks(),
        dialogs: this.dialogs,
        isDirect: (roomId) => this.#roomList.byId(roomId)?.is_direct ?? false,
      }
    );
    this.swipe = new MessageSwipe({
      enabled: () =>
        !this.selecting &&
        this.actionable &&
        (this.swipeOpensMembers || this.actions.onReply !== undefined),
      canEdit: () =>
        !this.selecting &&
        this.actionable &&
        !this.swipeOpensMembers &&
        this.actions.onEdit !== undefined,
      onReply: () => {
        const { selected, onCancelContext, onSwipeMembers } = this.#options();
        if (this.swipeOpensMembers) onSwipeMembers?.();
        else if (selected) onCancelContext?.();
        else this.actions.onReply?.();
      },
      onEdit: () => {
        const { editing, onCancelContext } = this.#options();
        if (editing) onCancelContext?.();
        else this.actions.onEdit?.();
      },
    });
    this.press = new LongPress({
      enabled: () => !this.selecting && (this.actionable || this.canCancelSend),
      onPress: (event) => {
        const { item } = this.#options();
        this.menu.set(item.id, false);
        const selected = selectedText(this.element);
        const link = this.#linkActions(event);
        this.dialogs.open(item, {
          kind: 'sheet',
          actions: () => ({ ...withSelectedText(this.actions, selected), ...link }),
        });
      },
    });
    this.#doubleTap = new DoubleTap(() => {
      if (
        this.selecting ||
        !this.actionable ||
        !preferences.doubleTapReact ||
        !this.actions.onReact
      )
        return;
      hapticFeedback();
      this.actions.onReact(preferences.doubleTapReaction);
    });

    $effect(() => {
      const { item, replySender, preview, loadPreviewProfile } = this.#options();
      this.profiles.sync(item.sender, replySender, preview && !loadPreviewProfile);
    });

    // A virtualised row can unmount mid-press, so the pending timer has to go.
    onDestroy(() => {
      this.press.cancel();
      this.profiles.dispose();
    });
  }

  readonly profile = $derived(this.profiles.sender);
  readonly senderTimezone = $derived(this.profile?.timezone ?? null);
  readonly senderCosmetics = $derived.by(() => {
    const { item, overrideCosmetics } = this.#options();
    return overrideCosmetics ?? this.#roomCosmetics?.for(item.sender) ?? null;
  });
  readonly senderRole = $derived.by(() => {
    const { item } = this.#options();
    return item.sender ? (this.#senderRoles?.(item.sender) ?? null) : null;
  });
  readonly senderColors = $derived.by(() => {
    const { item } = this.#options();
    return this.#senderColors(item.sender, this.profile, {
      persona: item.per_message_profile,
      isOwn: item.is_own,
      cosmetics: this.senderCosmetics,
      roleColor: this.senderRole?.color,
    });
  });
  readonly stalled = $derived.by(() => {
    const { send_state } = this.#options().item;
    return send_state?.status === 'failed' ? send_state : null;
  });
  readonly pending = $derived.by(() => this.#options().item.send_state?.status === 'sending');
  readonly swipeOpensMembers = $derived.by(
    () =>
      preferences.messageSwipeAction === 'members' && this.#options().onSwipeMembers !== undefined
  );
  readonly selecting = $derived(this.selection?.active ?? false);
  readonly multiSelected = $derived.by(
    () => this.selection?.has(this.#options().item.event_id) ?? false
  );
  readonly actionable = $derived.by(() => {
    const { item, preview } = this.#options();
    return !preview && item.event_id !== null && this.stalled === null && !this.pending;
  });
  readonly canCancelSend = $derived.by(() => {
    const { item, preview, onCancelSend } = this.#options();
    return !preview && this.pending && item.transaction_id !== null && onCancelSend !== undefined;
  });
  readonly actions = $derived.by((): MessageActions => {
    if (!this.canCancelSend) {
      const base = this.actionExecutor.actions;
      if (!this.actionable || this.selection === null || this.selecting) return base;
      return {
        ...base,
        onSelect: () => {
          this.selection?.enter(this.#options().item);
        },
      };
    }
    return {
      onCancelSend: () => {
        const { item, onCancelSend } = this.#options();
        if (this.pending && item.transaction_id) onCancelSend?.(item.transaction_id);
      },
    };
  });
  readonly showActions = $derived(
    !this.selecting &&
      (this.actionable || this.canCancelSend) &&
      (this.engagement.engaged || this.actionsPinned)
  );

  attach = (node: HTMLElement): (() => void) => {
    this.element = node;
    const detachSwipe = this.swipe.attach(node);
    const offClick = on(node, 'click', this.#onRowClick);
    return () => {
      detachSwipe();
      offClick();
      this.element = null;
    };
  };

  #onRowClick = (event: MouseEvent): void => {
    const fromToggle =
      event.target instanceof Element && event.target.closest('.select-toggle') !== null;
    if (
      !this.selecting ||
      !this.actionable ||
      (this.#options().editing && !fromToggle) ||
      event.button !== 0 ||
      event.defaultPrevented
    ) {
      return;
    }
    event.preventDefault();
    const focusedHere = this.element?.contains(document.activeElement) ?? false;
    const { item } = this.#options();
    if (event.shiftKey) this.selection?.selectRange(item);
    else this.selection?.toggle(item);
    if (focusedHere && !this.selection?.active) {
      this.element?.focus();
    }
  };

  pinActions = (open: boolean): void => {
    if (open) this.#anchor = null;
    this.actionsPinned = open;
    this.#options().onMenuOpenChange?.(open);
  };

  pointerDown = (event: PointerEvent): void => {
    this.press.start(event);
    this.#doubleTap.down(event);
    if (event.pointerType === 'mouse') this.engagement.hold();
  };

  pointerUp = (event: PointerEvent): void => {
    this.press.end(event);
    this.#doubleTap.up(event);
  };

  pointerCancel = (event: PointerEvent): void => {
    this.press.end(event);
    this.#doubleTap.cancel();
  };

  openContextMenu = (event: MouseEvent): void => {
    if (this.selecting) {
      event.preventDefault();
      return;
    }
    const { item } = this.#options();
    if (this.press.touch || touchContextMenu(event)) {
      event.preventDefault();
      if (
        (this.actionable || this.canCancelSend) &&
        !this.press.pending &&
        !this.dialogs.isOpen(item, 'sheet')
      )
        this.press.fire(event);
      return;
    }
    if (!this.actionable && !this.canCancelSend) {
      if (this.pending) event.preventDefault();
      return;
    }
    event.preventDefault();
    this.#anchor = cursorAnchor(event);
    const selected = selectedText(this.element);
    const link = this.#linkActions(event);
    this.menu.open(item.id, { x: event.clientX, y: event.clientY }, () => ({
      ...withSelectedText(this.actions, selected),
      ...link,
    }));
  };

  #linkActions(
    event: Event
  ): Pick<MessageActions, 'linkDestination' | 'onCopyHref' | 'onShareHref'> {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>('a[href]')?.href;
    if (!link || !this.actionable) return {};
    const concealed = target.closest('[data-mx-spoiler]:not([aria-pressed="false"])');
    const matrix = concealed ? null : parseMatrixLink(link);
    return {
      linkDestination: matrix ? matrixLinkDestination(matrix) : undefined,
      onCopyHref: () => {
        void copyText(link)
          .then(() => toasts.info(i18n.t('timeline.linkCopied')))
          .catch(() => toasts.error(i18n.t('errors.copyFailed')));
      },
      onShareHref: sharesLinks()
        ? () => {
            void shareLink(link).catch((error: unknown) => {
              console.debug('[sable timeline] share dismissed', error);
            });
          }
        : undefined,
    };
  }
}
