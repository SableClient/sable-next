import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { onDestroy, type Snippet } from 'svelte';

import type { MemberView, PerMessageProfileView } from '#src/generated/protocol';

import { copyText } from '#lib/platform/clipboard.js';
import { useCoreClient } from '#lib/core/context.js';
import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
import { LongPress, touchContextMenu } from '#lib/ui/long-press.svelte.js';
import { DoubleTap } from '#lib/ui/double-tap.js';
import { hapticFeedback } from '#lib/platform/haptics.js';
import { usePersonaStore } from '#lib/personas/personas.svelte.js';
import { preferences, type TimelineLayout } from '#lib/settings/preferences.svelte.js';
import { useBookmarks } from '#lib/rooms/bookmarks.svelte.js';
import { useRoomCosmetics, type SenderCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
import type { MatrixLink } from '#lib/rooms/matrix-link.js';

import { senderDisplayColors } from '../members/members.js';
import { hasSenderRoles, useSenderRoles } from '../members/sender-roles.js';
import { MessageSwipe } from '../messages/message-swipe.svelte.js';
import { useMessageMenu } from '../messages/message-menu-open.svelte.js';
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

export interface TimelineItemProps extends MessageCallbacks {
  item: ResolvedItem;
  collapsed: boolean;
  unreadCount?: number;
  replyPersona?: PerMessageProfileView | null;
  threadPersona?: PerMessageProfileView | null;
  roomId?: string;
  highlighted?: boolean;
  onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  onSenderProfile?: (
    userId: string,
    anchor: HTMLElement,
    pmp?: PerMessageProfileView | null
  ) => void;
  onMentionUser?: (userId: string, name: string) => void;
  onRetrySend?: (transactionId: string) => void;
  onCancelSend?: (transactionId: string) => void;
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
  onOpenMedia?: (eventId: string) => void;
  onVotePoll?: (eventId: string, answers: string[]) => void;
  onEndPoll?: (eventId: string) => void;
  events?: TimelineEventIndex;
  onMenuOpenChange?: (open: boolean) => void;
  placeholder?: boolean;
  placeholderCharacters?: number;
  overrideCosmetics?: SenderCosmetics | null;
}

export interface TimelineRowOptions extends MessageCallbacks {
  item: ResolvedItem;
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
  onMenuOpenChange?: (open: boolean) => void;
}

export class TimelineRow {
  element = $state<HTMLElement | null>(null);
  #anchor = $state.raw<CursorAnchor | null>(null);
  actionsPinned = $state(false);

  readonly core = useCoreClient();
  readonly dialogs = useMessageDialogs();
  readonly menu = useMessageMenu();
  readonly profiles = new TimelineItemProfiles(this.core);
  readonly engagement = new TimelineItemEngagement(() => this.element);
  readonly actionExecutor: MessageActionExecutor;
  readonly swipe: MessageSwipe;
  readonly press: LongPress;
  readonly #doubleTap: DoubleTap;
  readonly #roomCosmetics = useRoomCosmetics();
  readonly #senderRoles = hasSenderRoles() ? useSenderRoles() : null;
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
      }
    );
    this.swipe = new MessageSwipe({
      enabled: () => this.actionable && this.actions.onReply !== undefined,
      canEdit: () => this.actionable && this.actions.onEdit !== undefined,
      onReply: () => {
        const { selected, onCancelContext } = this.#options();
        if (selected) onCancelContext?.();
        else this.actions.onReply?.();
      },
      onEdit: () => {
        const { editing, onCancelContext } = this.#options();
        if (editing) onCancelContext?.();
        else this.actions.onEdit?.();
      },
    });
    this.press = new LongPress({
      enabled: () => this.actionable,
      onPress: () => {
        const { item } = this.#options();
        this.menu.set(item.id, false);
        const selected = selectedText(this.element);
        this.dialogs.open(item, {
          kind: 'sheet',
          actions: () => withSelectedText(this.actions, selected),
        });
      },
    });
    this.#doubleTap = new DoubleTap(() => {
      if (!this.actionable || !preferences.doubleTapReact || !this.actions.onReact) return;
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
    return senderDisplayColors(
      item.sender ?? '',
      this.profile,
      item.per_message_profile,
      item.is_own,
      this.senderCosmetics,
      this.senderRole?.color ?? null
    );
  });
  readonly stalled = $derived.by(() => {
    const { send_state } = this.#options().item;
    return send_state?.status === 'failed' ? send_state : null;
  });
  readonly pending = $derived.by(() => this.#options().item.send_state?.status === 'sending');
  readonly actionable = $derived.by(() => {
    const { item, preview } = this.#options();
    return !preview && item.event_id !== null && this.stalled === null && !this.pending;
  });
  readonly actions = $derived.by(() => this.actionExecutor.actions);
  readonly showActions = $derived(
    this.actionable && (this.engagement.engaged || this.actionsPinned)
  );

  attach = (node: HTMLElement): (() => void) => {
    this.element = node;
    const detachSwipe = this.swipe.attach(node);
    return () => {
      detachSwipe();
      this.element = null;
    };
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
    const { item } = this.#options();
    if (this.press.touch || touchContextMenu(event)) {
      event.preventDefault();
      if (this.actionable && !this.press.pending && !this.dialogs.isOpen(item, 'sheet'))
        this.press.fire(event);
      return;
    }
    if (!this.actionable) {
      if (this.pending) event.preventDefault();
      return;
    }
    event.preventDefault();
    this.#anchor = cursorAnchor(event);
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>('a[href]')?.href
        : null;
    const selected = selectedText(this.element);
    this.menu.open(item.id, { x: event.clientX, y: event.clientY }, () => ({
      ...withSelectedText(this.actions, selected),
      onCopyHref: link ? () => void copyText(link) : undefined,
    }));
  };
}
