<script lang="ts">
  import { page } from '$app/state';
  import { onDestroy, tick, untrack, type Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
  import ArrowUDownLeftIcon from 'phosphor-svelte/lib/ArrowUDownLeftIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
  import AtIcon from 'phosphor-svelte/lib/AtIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { dismissKeyboardOnScroll, keepKeyboardOnTap } from '#lib/platform/keyboard.js';
  import { windowActivity } from '#lib/platform/window-activity.js';
  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { MOTION_MS, motionMs, shouldReduceMotion } from '#lib/ui/motion.js';
  import {
    TimelineWindow,
    recallTimelineView,
    rememberTimelineView,
    timelineSizes,
    type TimelineEntry,
    type TimelineRow,
    type TimelineWindowState,
  } from '#lib/timeline/timeline-window.js';
  import { flushed } from '#lib/ui/flushed.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { rovingFocus } from '#lib/ui/roving-focus.js';
  import {
    isComposingKey,
    isDialogOpen,
    isEditableTarget,
    matchesBinding,
  } from '#lib/ui/shortcuts/binding.js';
  import { bindingFor } from '#lib/ui/shortcuts/bindings.svelte.js';
  import { isMacPlatform } from '#lib/ui/shortcuts/global-shortcuts.js';

  import MessageContextMenu from '../messages/MessageContextMenu.svelte';
  import MessageDialogHost from '../messages/MessageDialogHost.svelte';
  import MessageSelectionBar from '../messages/MessageSelectionBar.svelte';
  import { useEventItems } from '../messages/event-items.svelte.js';
  import { MessageDialogs, provideMessageDialogs } from '../messages/message-dialogs.svelte.js';
  import { OpenMessageMenu, provideMessageMenu } from '../messages/message-menu-open.svelte.js';
  import {
    isSelectable,
    MessageSelection,
    provideMessageSelection,
  } from '../messages/message-selection.svelte.js';
  import ChatBackground from './ChatBackground.svelte';
  import { LoadRetry } from './load-retry';
  import TimelineItem from './TimelineItem.svelte';
  import TimelineMemberGroup from './TimelineMemberGroup.svelte';
  import TimelineBeforeJoinGroup from './TimelineBeforeJoinGroup.svelte';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';
  import TimelineAnnouncements from './TimelineAnnouncements.svelte';
  import TimelineSkeleton from './TimelineSkeleton.svelte';
  import TypingIndicator, { type TypingUser } from './TypingIndicator.svelte';
  import { TimelineEventIndex } from './timeline-event-index';
  import {
    cumulativeReadBy,
    cumulativeReadTimestamps,
    latestEventId,
    personaLookup,
    replyTarget,
    type ReplyDirection,
  } from './timeline-format';
  import { TimelinePagination } from './timeline-pagination.svelte.js';
  import { TimelineFocus } from './timeline-focus.svelte.js';
  import { TimelineReadPosition } from './timeline-read-position.svelte.js';
  import { TimelineReturnStack } from './timeline-return-stack.svelte.js';
  import { TimelineMentions } from './timeline-mentions.svelte.js';
  import { TimelineFuture } from './timeline-future.svelte.js';
  import { TimelineHistoryController } from './timeline-history';
  import { holdsEvent, TimelineRows, type RowValue } from './timeline-rows.svelte.js';
  import { TimelineUnread } from './timeline-unread.svelte.js';
  import {
    estimatedColumnPx,
    estimateRowSize,
    mediaColumnPx,
    TIMELINE_LAYOUT,
    timelineLayoutStyle,
  } from './timeline-layout';

  import type { TimelineCallbacks } from './timeline-row.svelte.js';

  interface Props {
    timeline: RoomTimeline;
    callbacks?: TimelineCallbacks;
    focusEventId?: string | null;
    landingEventId?: string | null;
    replyEventId?: string | null;
    editEventId?: string | null;
    inlineEditor?: Snippet;
    onLanded?: () => void;
    onReturnedToLatest?: () => void;
    onRequestHistory: (count?: number) => Promise<boolean>;
    onRequestFuture: () => Promise<void>;
    onRetryLoad?: () => Promise<void>;
    threadRootId?: string | null;
    onRead: (eventId: string, fullyRead: boolean) => Promise<void>;
    onFullyRead?: (roomId: string, eventId: string) => void;
    hasUnread?: boolean;
    /** Unread mentions of the reader in this timeline, oldest first. */
    mentionEventIds?: readonly string[];
    onLoadReadMarker?: () => Promise<string | null>;
    onRequestUnread?: (eventId: string) => Promise<void>;
    onResumeLive?: () => Promise<void>;
    onMarkRead?: () => Promise<void>;
    currentUserId?: string | null;
    roomId?: string;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string, origin?: string | null) => void;
    onJumpToLive?: () => void;
    onReturnToPosition?: () => void;
    readOnly?: boolean;
    canRedactOwn?: boolean;
    canRedactOthers?: boolean;
    canPin?: boolean;
    encrypted?: boolean | null;
    active?: boolean;
    scrollLocked?: boolean;
    nearLatest?: boolean;
    followingLive?: boolean;
    typingUsers?: readonly TypingUser[];
    footTrailing?: Snippet;
    footTrailingVisible?: boolean;
    timelineStart?: Snippet;
  }

  let {
    timeline,
    focusEventId = null,
    landingEventId = null,
    replyEventId = null,
    editEventId = null,
    inlineEditor,
    onLanded,
    onReturnedToLatest,
    onRequestHistory,
    onRequestFuture,
    onRetryLoad,
    threadRootId = null,
    onRead,
    onFullyRead,
    hasUnread = false,
    mentionEventIds = [],
    onLoadReadMarker,
    onRequestUnread,
    onResumeLive,
    onMarkRead,
    callbacks = {},
    currentUserId,
    roomId,
    members = [],
    onJumpToEvent,
    onJumpToLive,
    onReturnToPosition,
    readOnly = false,
    canRedactOwn = true,
    canRedactOthers = false,
    canPin = true,
    encrypted = null,
    active = true,
    scrollLocked = false,
    nearLatest = $bindable(true),
    followingLive = $bindable(false),
    typingUsers = [],
    footTrailing,
    footTrailingVisible = false,
    timelineStart,
  }: Props = $props();

  const dialogs = provideMessageDialogs(new MessageDialogs());
  const messageMenu = provideMessageMenu(new OpenMessageMenu());

  const unread = new TimelineUnread();
  const appLayout = new AppLayout();
  let unreadNavigation: AbortController | null = null;
  let jumpingUnread = $state(false);
  let markingRead = $state(false);
  let unreadError = $state<'jump' | 'read' | null>(null);
  let switchingToUnread = false;
  let resumeTask: Promise<void> | null = null;
  let resumeFailed = $state(false);
  let reading = $derived(
    active && page.state.settings === undefined && !appLayout.drawerCovers(page.state)
  );
  const readRoomId = untrack(() => roomId);
  const viewScope = readRoomId ? `${readRoomId}:${untrack(() => threadRootId) ?? ''}` : null;
  const readPosition = new TimelineReadPosition({
    roomId: readRoomId ?? null,
    timeline: () => timeline,
    windowState: () => windowState,
    canRead: () => revealed && viewport !== null && !unread.blocking && !markingRead,
    onFullyRead: () => onFullyRead,
  });
  $effect(() => {
    if (!windowActivity.active) untrack(() => readPosition.settle());
  });
  const loadRetry = new LoadRetry();
  onDestroy(() => {
    unreadNavigation?.abort();
    unread.destroy();
    readPosition.settle();
    loadRetry.reset();
  });
  let followingRead = $state(false);
  const rowModel = new TimelineRows({
    timeline: () => timeline,
    readOnly: () => readOnly,
    threadRootId: () => threadRootId,
    readMarkerBefore: () => unread.firstEventId,
    followingRead: () => followingRead,
  });
  const eventItems = $derived(rowModel.eventItems);
  const visibleItems = $derived(rowModel.visibleItems);
  const entries = $derived(rowModel.entries);
  let events = $derived(new TimelineEventIndex(timeline.items, timeline.aggregations));
  const selection = provideMessageSelection(new MessageSelection(() => visibleItems));
  let selectionBar = $state<MessageSelectionBar>();
  let selectableCount = $derived(visibleItems.filter(isSelectable).length);
  holdOverlayBack(
    () => selection.active,
    () => {
      selectionBar?.cancelOrClear();
    }
  );
  let selectionAnnouncement = $state('');
  let previousSelectedCount = 0;
  $effect(() => {
    const count = selection.count;
    if (count === previousSelectedCount) return;
    previousSelectedCount = count;
    selectionAnnouncement =
      count > 0
        ? i18n.t('timeline.selectionAnnounce', { count })
        : i18n.t('timeline.selectionCleared');
  });
  function entryFor(eventId: string | null): TimelineEntry<RowValue> | undefined {
    return entries.find(({ value }) => holdsEvent(value, eventId));
  }
  let rows = $state.raw<readonly TimelineRow<RowValue>[]>([]);
  let windowState = $state.raw<TimelineWindowState<RowValue>>({
    start: 0,
    end: 0,
    firstVisible: null,
    lastVisible: null,
    lastFullyVisible: null,
    rows: [],
    pinned: true,
    scrolling: false,
  });
  let controller = $state.raw<TimelineWindow<RowValue> | null>(null);
  let mediaColumn = mediaColumnPx(0);
  let viewport = $state<HTMLDivElement | null>(null);
  let revealed = $state(false);
  let preview = $state(false);
  let jumpToLatestVisible = $state(false);
  let opening = false;
  let filling = $state(false);
  let opened = $state(false);
  let disposed = false;
  let refillPending = $state(false);
  const fetchedItems = useEventItems();
  let personas = $derived(
    personaLookup(timeline.items, (eventId) =>
      roomId && eventId ? (fetchedItems.get(roomId, eventId)?.per_message_profile ?? null) : null
    )
  );
  let readersByItem = $derived(cumulativeReadBy(timeline.items));
  let receiptTimestampsByItem = $derived(cumulativeReadTimestamps(timeline.items));
  let menuOpen = $state(false);
  const pagination = new TimelinePagination(
    () => timeline,
    (count) => onRequestHistory(count)
  );
  const future = new TimelineFuture(
    () => timeline,
    () => onRequestFuture()
  );
  function requestFuture(manual = false): Promise<void> {
    return future.request(manual);
  }
  function loadFuture(manual = false): void {
    void requestFuture(manual).catch((error: unknown) => {
      console.warn('[sable timeline] loading newer messages failed', error);
    });
  }
  const focus = new TimelineFocus<RowValue>({
    timeline: () => timeline,
    viewport: () => viewport,
    entries: () => entries,
    target: () => focusEventId,
    history: pagination,
    requestFuture: () => requestFuture(),
    canRequestFuture: () => future.canRefill(),
  });
  let noHistory = $derived(
    visibleItems.length === 0 && (pagination.exhausted || timeline.backwardPagination === 'end')
  );
  let awaitingContent = $derived(
    visibleItems.length === 0 && timeline.error === null && !noHistory
  );
  let emptyFailure = $derived(visibleItems.length === 0 && timeline.error !== null);
  $effect(() => {
    if (visibleItems.length > 0) {
      loadRetry.reset();
      return;
    }
    if (
      !emptyFailure ||
      timeline.loading ||
      timeline.mode.kind === 'focused' ||
      !windowActivity.visible ||
      !onRetryLoad
    ) {
      loadRetry.cancel();
      return;
    }
    loadRetry.schedule(() => void onRetryLoad());
    return () => loadRetry.cancel();
  });
  let atLatest = $derived(windowState.pinned && timeline.reachesLatest);
  let unreadCount = $derived(unread.count(eventItems));
  let unreadInView = $derived.by(() => {
    const index = entries.findIndex(({ value }) => holdsEvent(value, unread.firstEventId));
    return (
      index >= 0 &&
      windowState.firstVisible !== null &&
      windowState.lastVisible !== null &&
      index >= windowState.firstVisible &&
      index <= windowState.lastVisible
    );
  });
  $effect(() => {
    const focused = windowActivity.active;
    if (opened && live)
      untrack(() => unread.trackBackground(eventItems, focused && !windowActivity.recentlyResumed));
    unread.resolve(timeline.items, oldestUnreadLoaded, eventItems);
    if (!reading || !revealed || !focused) return;
    if (unreadInView) unread.observe(unread.firstEventId);
    else if (atLatest && opened && !jumpingUnread && !unread.background) unread.reachLatest();
  });
  let holdAtLatest = $state(untrack(() => !preferences.openRoomsAtUnread && hasUnread));
  let hadUnread = untrack(() => hasUnread);
  $effect(() => {
    if (hadUnread && !hasUnread && unread.initialized && !holdAtLatest)
      untrack(() => unread.dismiss());
    hadUnread = hasUnread;
  });
  let historyLoading = $derived(
    revealed &&
      visibleItems.length > 0 &&
      (pagination.pending || timeline.backwardPagination === 'loading')
  );
  let live = $derived(timeline.mode.kind === 'live');
  let oldestUnreadLoaded = $derived(
    (timeline.backwardPagination === 'end' || pagination.exhausted) &&
      (live || timeline.forwardPagination === 'end')
  );
  let futureLoading = $derived(
    revealed && !live && visibleItems.length > 0 && timeline.forwardPagination === 'loading'
  );
  const mentions = new TimelineMentions({
    timeline: () => timeline,
    eventIds: () => mentionEventIds,
  });
  $effect(() => {
    const { firstVisible, lastVisible, rows } = windowState;
    // The list arrives after its message is on screen, so it has to rerun this too.
    const mentionIds = mentionEventIds;
    if (!reading || !revealed || !windowActivity.active) return;
    if (firstVisible === null || lastVisible === null) return;
    untrack(() => {
      for (const { index, value } of rows) {
        const eventId = value.item.event_id;
        if (
          index >= firstVisible &&
          index <= lastVisible &&
          eventId &&
          mentionIds.includes(eventId)
        )
          mentions.markSeen(eventId);
      }
    });
  });
  /** The message a jump control is heading to, focused once it is on screen. */
  let jumpFocusId = $state<string | null>(null);
  let jumps = $state<HTMLElement | null>(null);
  $effect(() => {
    const eventId = jumpFocusId;
    const { firstVisible, lastVisible, rows } = windowState;
    if (eventId === null || firstVisible === null || lastVisible === null) return;
    const row = rows.find(
      ({ index, value }) =>
        index >= firstVisible && index <= lastVisible && holdsEvent(value, eventId)
    );
    if (!row) return;
    jumpFocusId = null;
    // A reader who moved on to the composer or elsewhere keeps their focus.
    const focused = document.activeElement;
    if (focused === null || focused === document.body || jumps?.contains(focused))
      articleFor(row.key)?.focus({ preventScroll: true });
  });
  const returns = new TimelineReturnStack({
    entries: () => entries,
    lastVisible: () => windowState.lastVisible,
  });
  let historyLoadingVisible = $state(false);
  $effect(() => {
    if (historyLoading) {
      historyLoadingVisible = true;
      return;
    }
    if (!historyLoadingVisible) return;
    const timer = setTimeout(() => {
      historyLoadingVisible = false;
    }, TIMELINE_LAYOUT.historyLoadingLinger);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    followingLive = revealed && windowState.pinned;
  });

  function fillsViewport(engine: TimelineWindow<RowValue>, node: HTMLElement): boolean {
    return engine.contentHeight >= node.clientHeight || node.scrollHeight > node.clientHeight;
  }
  function requestHistory(count?: number): Promise<boolean> {
    return pagination.requestHistory(count);
  }
  let fillRequested = false;
  function requestFill(): Promise<boolean> {
    const count = fillRequested ? TIMELINE_LAYOUT.openingFillPageItems : undefined;
    fillRequested = true;
    return requestHistory(count);
  }
  const historyController = new TimelineHistoryController({
    getBackwardPagination: () => timeline.backwardPagination,
    isNearOldest: () =>
      viewport !== null &&
      windowState.start === 0 &&
      viewport.scrollTop < viewport.clientHeight * 2,
    isScrolling: () => windowState.scrolling,
    requestHistory,
  });
  function windowChanged(state: TimelineWindowState<RowValue>): void {
    const wasScrolling = windowState.scrolling;
    if (state.pinned && !windowState.pinned) returns.clear();
    windowState = state;
    const node = viewport;
    const height = node?.clientHeight ?? 0;
    const distance = node === null ? 0 : node.scrollHeight - height - node.scrollTop;
    jumpToLatestVisible =
      !state.pinned &&
      (state.end !== entries.length ||
        (node !== null && distance >= height * TIMELINE_LAYOUT.jumpToLatestPages));
    nearLatest =
      state.end === entries.length &&
      node !== null &&
      distance <= TIMELINE_LAYOUT.jumpToLatestRem * 16;
    if (!state.pinned) followingRead = false;
    if (wasScrolling && !state.scrolling) historyController.onScrollSettled();
  }
  function readerScrolled(delta: number): void {
    historyController.clearUserScrollPending();
    if (!revealed) return;
    if (delta < 0) holdAtLatest = false;
    if (delta > 0 && atLatest && windowActivity.active && !holdAtLatest) unread.reachLatest();
    if (delta > 0 && live && windowState.pinned) onReturnedToLatest?.();
    historyController.observeScroll(delta < 0, nearLatest);
    if (
      timeline.mode.kind !== 'live' &&
      timeline.forwardPagination === 'idle' &&
      windowState.lastVisible !== null &&
      windowState.lastVisible >= entries.length - TIMELINE_LAYOUT.historyPrefetchItems
    ) {
      loadFuture(true);
    }
  }
  function mountWindow(node: HTMLDivElement): () => void {
    const canvas = node.querySelector<HTMLElement>('.items');
    const content = node.querySelector<HTMLElement>('.window-rows');
    if (!canvas || !content) throw new Error('Timeline window elements are missing');
    let column: HTMLElement | null = null;
    const widths = new ResizeObserver(() => {
      measureMediaColumn();
    });
    function measureMediaColumn(): void {
      const main = node.querySelector<HTMLElement>('.message-main');
      if (main !== column) {
        if (column) widths.unobserve(column);
        column = main;
        if (column) widths.observe(column);
      }
      mediaColumn = mediaColumnPx(main?.clientWidth ?? estimatedColumnPx(node.clientWidth));
    }
    measureMediaColumn();
    widths.observe(node);
    const engine = new TimelineWindow<RowValue>({
      viewport: node,
      canvas,
      content,
      render: async (next) => {
        rows = next;
        await flushed();
        if (!disposed) measureMediaColumn();
      },
      onChange: windowChanged,
      onScroll: readerScrolled,
      onInteraction: () => {
        focus.cancel();
        unreadNavigation?.abort();
        if (
          !live &&
          timeline.forwardPagination === 'idle' &&
          (future.failed || !future.canRefill()) &&
          windowState.lastVisible !== null &&
          windowState.lastVisible >= entries.length - TIMELINE_LAYOUT.historyPrefetchItems
        ) {
          loadFuture(true);
        }
        abandonLanding();
      },
      isAnchor: ({ item }) => item.event_id !== null,
      estimateSize: ({ item }) => estimateRowSize(item.content, mediaColumn),
      sizes: viewScope ? timelineSizes(viewScope) : undefined,
      canFollowLatest: () => untrack(() => timeline.reachesLatest),
    });
    controller = engine;
    return () => {
      if (viewScope && opened && timeline.mode.kind === 'live')
        rememberTimelineView(viewScope, engine.view);
      disposed = true;
      focus.cancel();
      widths.disconnect();
      engine.destroy();
      controller = null;
    };
  }
  $effect(() => {
    const engine = controller;
    const next = entries;
    const error = timeline.error;
    const loading = timeline.loading || (!timeline.hasSnapshot && !error);
    const cached = timeline.loading && timeline.hasSnapshot;
    if (!engine) return;
    void engine.update(next).then(() => {
      if (disposed) return;
      if (cached) preview = true;
      if (!loading && (!preview || error === null)) void openTimeline(engine);
    });
  });
  $effect(() => {
    if (
      live ||
      timeline.loading ||
      timeline.resumingLive ||
      !timeline.hasSnapshot ||
      timeline.error !== null ||
      !revealed ||
      filling ||
      focus.filling ||
      future.pending ||
      timeline.forwardPagination !== 'idle' ||
      windowState.lastVisible === null ||
      windowState.lastVisible < entries.length - TIMELINE_LAYOUT.historyPrefetchItems
    )
      return;
    if (!future.canRefill()) return;
    loadFuture();
  });
  async function openTimeline(engine: TimelineWindow<RowValue>): Promise<void> {
    if (opening || disposed) return;
    opening = true;
    await flushed();
    await new Promise(requestAnimationFrame);
    if (disposed) return;
    if (timeline.loading || (!timeline.hasSnapshot && !timeline.error)) {
      opening = false;
      return;
    }
    await engine.update(entries);
    const initializingUnread = unread.initialize(
      timeline.items,
      hasUnread,
      onLoadReadMarker,
      eventItems,
      timeline.readMarkerEventId
    );
    const landingPending = landingEventId !== null && onRequestUnread !== undefined;
    const remembered =
      viewScope && live && !focusEventId ? recallTimelineView(viewScope) : undefined;
    const resumeView =
      remembered && !landingEventId && entries.some((entry) => entry.key === remembered.key)
        ? remembered
        : undefined;
    const markerEntry = () =>
      unread.active
        ? entries.find(({ value }) => value.item.content.kind === 'read_marker')
        : undefined;
    if (!resumeView && !markerEntry() && !entryFor(landingEventId) && !landingPending) {
      revealed = true;
    }
    await initializingUnread;
    if (disposed) return;
    unread.resolve(timeline.items, oldestUnreadLoaded, eventItems);
    if (focusEventId) {
      const target = focusEventId;
      const entry = entryFor(focusEventId);
      if (entry) handledFocus = target;
      revealed = true;
      if (entry) await focus.position(engine, target, entry.key, false);
      return;
    }
    const landingEntry = () => entryFor(landingEventId);
    const unreadEntry = markerEntry();
    if (!resumeView && !unreadEntry && !landingEntry() && !landingPending) revealed = true;
    filling = true;
    try {
      if (resumeView && !disposed && (await engine.resume(resumeView))) return;
      const notified = landingEntry();
      const landing = notified ?? (landingPending || holdAtLatest ? undefined : unreadEntry);
      if (landing && !disposed && engine.state.pinned) {
        if (notified) markLanded(landingEventId);
        await engine.jumpTo(landing.key, landing === unreadEntry ? 'start' : 'center');
      } else if (!notified && !disposed) {
        const landed = landingPending && (await landOnUnloaded(engine, landingEventId));
        if (
          !landed &&
          !holdAtLatest &&
          unread.active &&
          unread.firstEventId !== null &&
          !disposed
        ) {
          await jumpToUnread();
        } else if (!landed && !engine.state.pinned && timeline.reachesLatest) {
          await engine.jumpTo(null, 'start');
        }
      }
    } catch (error) {
      console.warn('[sable timeline] opening the timeline failed', error);
      pagination.exhausted = false;
    } finally {
      filling = false;
      if (!disposed) {
        revealed = true;
        opened = true;
      }
    }
  }
  $effect(() => {
    const count = visibleItems.length;
    pagination.observeItems();
    const engine = controller;
    const node = viewport;
    if (
      timeline.loading ||
      timeline.resumingLive ||
      (timeline.mode.kind === 'focused' && timeline.forwardPagination !== 'end') ||
      timeline.error !== null ||
      !engine ||
      !revealed ||
      pagination.exhausted ||
      timeline.backwardPagination !== 'idle' ||
      pagination.pending ||
      filling ||
      focus.filling ||
      refillPending
    )
      return;
    if (count > 0 && !(node && windowState.start === 0 && !fillsViewport(engine, node))) return;
    if (!pagination.canRefill()) return;
    void refill();
  });
  async function refill(): Promise<void> {
    refillPending = true;
    try {
      pagination.exhausted = await requestFill();
    } catch (error) {
      console.warn('[sable timeline] loading older messages failed', error);
    } finally {
      refillPending = false;
    }
  }
  let sentEcho: string | null | undefined;
  $effect(() => {
    const engine = controller;
    const last = entries.at(-1)?.value.item;
    if (!engine || !revealed) return;
    const tail = last ? (last.transaction_id ?? last.event_id) : null;
    if (tail === sentEcho) return;
    const seeded = sentEcho !== undefined;
    sentEcho = tail;
    if (
      seeded &&
      (timeline.mode.kind === 'live' || timeline.mode.kind === 'thread') &&
      last?.is_own &&
      ((preferences.jumpToLatestOnSend && last.transaction_id !== null) ||
        untrack(() => nearLatest))
    )
      void engine.jumpTo(null, 'start');
  });
  export function composerFocused(event: FocusEvent): void {
    if (!controller || !revealed || !isEditableTarget(event.target)) return;
    if (nearLatest && !windowState.pinned) void controller.jumpTo(null, 'start');
  }
  export function composerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
    if (event.defaultPrevented || isComposingKey(event) || !isEditableTarget(event.target)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !viewport) return;
    event.preventDefault();
    const page = viewport.clientHeight * KEY_PAGE_FRACTION;
    viewport.scrollBy({ top: event.key === 'PageUp' ? -page : page });
  }
  const ARTICLE = 'article.message:not([aria-hidden="true"])';
  const KEY_PAGE_ITEMS = 8;
  const KEY_PAGE_FRACTION = 0.875;
  const FOCUSABLE = 'button, a[href], input, textarea, select, [tabindex]';
  const feedItems = rovingFocus({
    orientation: 'vertical',
    selector: ARTICLE,
    page: KEY_PAGE_ITEMS,
    contain: FOCUSABLE,
    initial: (items) => items.at(-1),
    restoreFocus: false,
    onBoundary: (move, from, distance) => void moveFocus(move, from, distance),
    annotate: (item) => {
      const row = item.closest<HTMLElement>('[data-index]');
      const position = row ? String(Number(row.dataset.index) + 1) : null;
      if (position && item.getAttribute('aria-posinset') !== position) {
        item.setAttribute('aria-posinset', position);
        item.setAttribute('aria-setsize', '-1');
      }
    },
  });
  function isArticleEntry({ group, item }: RowValue): boolean {
    return group === null && item.row !== 'annotation';
  }
  function articleFor(key: string): HTMLElement | null | undefined {
    return viewport?.querySelector<HTMLElement>(
      `[data-timeline-key="${CSS.escape(key)}"] ${ARTICLE}`
    );
  }
  async function moveFocus(move: 'start' | 'end', from: HTMLElement, distance: number) {
    const engine = controller;
    const key = from.closest<HTMLElement>('[data-timeline-key]')?.dataset.timelineKey;
    const at = entries.findIndex((entry) => entry.key === key);
    if (!engine || at < 0) return;
    const ahead = move === 'end' ? entries.slice(at + 1) : entries.slice(0, at).reverse();
    const candidates = ahead.filter((entry) => isArticleEntry(entry.value));
    const target =
      distance === Infinity
        ? candidates.at(-1)
        : candidates[Math.min(distance, candidates.length) - 1];
    if (!target) {
      if (move === 'start' && !pagination.exhausted && timeline.backwardPagination !== 'end') {
        void requestHistory()
          .then((end) => {
            pagination.exhausted = end;
          })
          .catch((error: unknown) => {
            console.warn('[sable timeline] loading history from the keyboard failed', error);
          });
      }
      return;
    }
    let article = articleFor(target.key);
    if (!article) {
      focus.cancel();
      if (!(await engine.jumpTo(target.key, 'center'))) return;
      await flushed();
      article = articleFor(target.key);
    }
    article?.focus();
  }
  function openMenuFromKeyboard(article: HTMLElement): void {
    const rect = article.getBoundingClientRect();
    const top = Math.max(rect.top, viewport?.getBoundingClientRect().top ?? rect.top);
    article.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.min(rect.width / 2, 48),
        clientY: top + Math.min(rect.height / 2, 24),
      })
    );
  }
  function itemForArticle(article: HTMLElement): TimelineItemView | null {
    const eventId = article.closest<HTMLElement>('[data-event-id]')?.dataset.eventId;
    return eventId ? events.get(eventId) : null;
  }
  function exitSelection(): void {
    const activeElement = document.activeElement;
    const shouldRestore =
      activeElement === null ||
      activeElement === document.body ||
      Boolean(activeElement.closest('.selection-bar, [role="dialog"]'));
    if (!shouldRestore) return;
    const fallback =
      viewport?.querySelector<HTMLElement>(`${ARTICLE}[tabindex="0"]`) ??
      viewport?.querySelector<HTMLElement>(ARTICLE);
    void tick().then(() => {
      if (
        fallback &&
        (document.activeElement === null ||
          document.activeElement === document.body ||
          !document.activeElement.isConnected)
      ) {
        fallback.focus();
      }
    });
  }
  function onTimelineKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || isComposingKey(event) || !active || !selection.active) return;
    if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]')) {
      return;
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (event.key === 'Escape' && !event.repeat && plain) {
      event.preventDefault();
      selectionBar?.cancelOrClear();
      return;
    }
    const mod = isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (
      mod &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'a' &&
      !isEditableTarget(event.target) &&
      !isDialogOpen()
    ) {
      event.preventDefault();
      selection.selectAll();
    }
  }
  function attachTimelineKeys(node: HTMLElement): () => void {
    return on(node, 'keydown', onTimelineKeydown);
  }
  function feedKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || event.defaultPrevented || isComposingKey(event)) return;
    const article = target.closest<HTMLElement>(ARTICLE);
    if (!article) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (
      !selection.active &&
      (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
    ) {
      event.preventDefault();
      openMenuFromKeyboard(article);
    } else if (
      target === article &&
      (event.key === ' ' || (selection.active && event.key === 'Enter'))
    ) {
      const shiftOnly = event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (!plain && !(shiftOnly && selection.active)) return;
      const item = itemForArticle(article);
      if (!item || !isSelectable(item)) return;
      event.preventDefault();
      if (shiftOnly) selection.selectRange(item);
      else selection.toggle(item);
    } else if (target === article && plain && (event.key === 'Enter' || event.key === 'F2')) {
      const control =
        article.querySelector<HTMLElement>('.message-actions button') ??
        article.querySelector<HTMLElement>(FOCUSABLE);
      if (!control) return;
      event.preventDefault();
      control.focus();
    } else if (target !== article && plain && event.key === 'Escape' && !isEditableTarget(target)) {
      event.preventDefault();
      if (selection.active) selectionBar?.cancelOrClear();
      article.focus();
    }
  }
  let handledFocus: string | null = null;
  let heldContext = $state<string | null>(null);
  $effect(() => {
    if (
      timeline.mode.kind !== 'unread' ||
      timeline.mode.eventId === heldContext ||
      timeline.forwardPagination !== 'end' ||
      timeline.loading ||
      timeline.resumingLive ||
      !revealed ||
      !onResumeLive ||
      !nearLatest
    )
      return;
    retryLive();
  });
  export function resumeLive(): Promise<void> {
    if (resumeTask) return resumeTask;
    if (!onResumeLive || !timeline.canResumeLive) return Promise.resolve();
    resumeFailed = false;
    const task = onResumeLive()
      .then(jumpToLiveEnd)
      .catch((error: unknown) => {
        if (!disposed) resumeFailed = true;
        throw error;
      })
      .finally(() => {
        if (resumeTask === task) resumeTask = null;
      });
    resumeTask = task;
    return task;
  }
  function retryLive(): void {
    void resumeLive().catch((error: unknown) => {
      console.warn('[sable timeline] resuming the live timeline failed', error);
    });
  }
  async function jumpToLiveEnd(): Promise<void> {
    await flushed();
    if (!disposed) await controller?.jumpTo(null, 'start');
  }
  $effect(() => {
    void focusEventId;
    void timeline.mode;
    untrack(() => {
      focus.cancel();
      if (!switchingToUnread) unreadNavigation?.abort();
      future.reset();
    });
  });
  $effect(() => {
    const target = focusEventId;
    const engine = controller;
    if (!engine || !revealed || target === handledFocus) return;
    if (target === null) {
      handledFocus = null;
      return;
    }
    const entry = entryFor(target);
    if (!entry) return;
    handledFocus = target;
    void focus.position(engine, target, entry.key, !shouldReduceMotion());
  });
  async function landOnUnloaded(
    engine: TimelineWindow<RowValue>,
    target: string,
    root = false
  ): Promise<boolean> {
    if (!onRequestUnread) return false;
    // The subscription already tried this context and kept its live snapshot.
    if (timeline.mode.kind === 'live' && timeline.readMarkerEventId === target) return false;
    switchingToUnread = true;
    try {
      await onRequestUnread(target);
    } catch (error) {
      console.warn('[sable timeline] loading the notified event failed', error);
      return false;
    } finally {
      switchingToUnread = false;
    }
    if (disposed) return true;
    await flushed();
    await engine.update(entries);
    const threadRoot = entryFor(target)?.value.item.thread_root ?? null;
    const landing = threadRoot ?? target;
    const entry = entryFor(landing);
    if (!entry) return threadRoot !== null && !root && landOnUnloaded(engine, threadRoot, true);
    markLanded(landing);
    await engine.jumpTo(entry.key, 'center');
    return true;
  }
  let handledLanding: string | null = null;
  let landedEventId = $state<string | null>(null);
  function markLanded(eventId: string | null): void {
    if (timeline.mode.kind === 'unread') heldContext = timeline.mode.eventId;
    handledLanding = landingEventId;
    landedEventId = eventId;
    onLanded?.();
  }
  function abandonLanding(): void {
    if (!revealed || landingEventId === null || landingEventId === handledLanding) return;
    handledLanding = landingEventId;
    onLanded?.();
  }
  $effect(() => {
    const target = landingEventId;
    const engine = controller;
    if (target === null) {
      handledLanding = null;
      return;
    }
    if (!engine || !revealed || target === handledLanding) return;
    if (focusEventId !== null || timeline.mode.kind === 'focused') {
      untrack(abandonLanding);
      return;
    }
    const entry = entryFor(target);
    if (!entry) return;
    untrack(() => markLanded(target));
    void engine.jumpTo(entry.key, 'center', !shouldReduceMotion());
  });
  function userScrollMarker(node: HTMLDivElement): () => void {
    return historyController.attach(node);
  }
  function setMenuOpen(open: boolean): void {
    menuOpen = open;
  }
  function scrollLock(locked: boolean) {
    return (node: HTMLElement) => {
      if (!locked) return;
      const block = (event: Event): void => {
        event.preventDefault();
      };
      const offWheel = on(node, 'wheel', block, { passive: false });
      const offTouchmove = on(node, 'touchmove', block, { passive: false });
      return () => {
        offWheel();
        offTouchmove();
      };
    };
  }
  async function markRead(eventId: string): Promise<void> {
    if (windowState.pinned) followingRead = true;
    const fullyRead = !holdAtLatest && eventId === latestEventId(timeline.items);
    await onRead(eventId, fullyRead);
    if (!holdAtLatest) readPosition.advance(eventId);
    if (fullyRead) readPosition.markFullyRead(eventId);
    if (disposed) {
      readPosition.settle();
      return;
    }
    if (!holdAtLatest && eventId === latestEventId(timeline.items)) unread.dismiss();
  }
  async function jumpToUnread(): Promise<void> {
    const engine = controller;
    if (!engine || jumpingUnread) return;
    focus.cancel();
    historyController.finishHistoryFill();
    const navigation = new AbortController();
    unreadNavigation?.abort();
    unreadNavigation = navigation;
    jumpingUnread = true;
    holdAtLatest = false;
    unreadError = null;
    const current = () => !disposed && !navigation.signal.aborted;
    try {
      await unread.initialize(
        timeline.items,
        hasUnread,
        onLoadReadMarker,
        eventItems,
        timeline.readMarkerEventId
      );
      if (unread.failed) {
        unreadError = 'jump';
        return;
      }
      if (current() && !entryFor(unread.firstEventId) && unread.readEventId && onRequestUnread) {
        switchingToUnread = true;
        try {
          await onRequestUnread(unread.readEventId);
        } finally {
          switchingToUnread = false;
        }
        await flushed();
      }
      if (!current()) return;
      unread.resolve(timeline.items, oldestUnreadLoaded, eventItems);
      if (!unread.active) return;
      const target = entryFor(unread.firstEventId);
      if (!target) {
        unreadError = 'jump';
        return;
      }
      await engine.update(entries);
      if (current()) await engine.jumpTo(target.key, 'start', false, navigation.signal);
    } catch (error) {
      console.warn('[sable timeline] jump to unread failed', error);
      if (current()) unreadError = 'jump';
    } finally {
      if (unreadNavigation === navigation) jumpingUnread = false;
    }
  }
  async function markAllRead(): Promise<void> {
    if (!onMarkRead || markingRead) return;
    unreadNavigation?.abort();
    markingRead = true;
    unreadError = null;
    try {
      await onMarkRead();
      if (!disposed) {
        unread.clear();
        followingRead = windowState.pinned;
      }
    } catch (error) {
      console.warn('[sable timeline] mark as read failed', error);
      if (!disposed) unreadError = 'read';
    } finally {
      if (!disposed) markingRead = false;
    }
  }
  export function dismissUnread(): void {
    unreadNavigation?.abort();
    unread.clear();
  }
  export function markUnreadFrom(eventId: string, readEventId: string | null): void {
    unreadNavigation?.abort();
    unreadError = null;
    holdAtLatest = false;
    unread.markUnreadFrom(eventId, readEventId);
  }
  let replayingEventId = $state<string | null>(null);
  async function replayHighlight(eventId: string): Promise<void> {
    replayingEventId = eventId;
    await flushed();
    await new Promise(requestAnimationFrame);
    if (replayingEventId === eventId) replayingEventId = null;
  }
  export function jumpToEvent(eventId: string): boolean {
    const key = entryFor(eventId)?.key;
    if (!key || !controller) return false;
    focus.cancel();
    void controller.jumpTo(key, 'center', !shouldReduceMotion());
    if (eventId === (focusEventId ?? landedEventId)) void replayHighlight(eventId);
    return true;
  }

  /** The event to come back to, or null at the latest messages, where jumping to latest already returns. */
  export function capturePosition(preferredEventId?: string | null): string | null {
    if (!controller || !opened) return null;
    if (preferredEventId != null && entryFor(preferredEventId)) return preferredEventId;
    if (windowState.pinned && live) return null;
    const first = windowState.firstVisible;
    if (first === null) return null;
    for (const row of windowState.rows) {
      if (row.index >= first && row.value.item.event_id) return row.value.item.event_id;
    }
    return null;
  }

  export function stepReply(direction: ReplyDirection): string | null {
    const target = replyTarget(eventItems, replyEventId, direction, preferences.showHiddenEvents);
    const key = entryFor(target)?.key;
    const row = key ? viewport?.querySelector(`[data-timeline-key="${CSS.escape(key)}"]`) : null;
    if (key && controller && viewport && !(row && withinViewport(row, viewport))) {
      focus.cancel();
      void controller.jumpTo(key, 'center', !shouldReduceMotion());
    }
    return target;
  }
  function withinViewport(row: Element, node: HTMLElement): boolean {
    const rowRect = row.getBoundingClientRect();
    const viewportRect = node.getBoundingClientRect();
    return rowRect.top >= viewportRect.top && rowRect.bottom <= viewportRect.bottom;
  }
  function jumpFrom(origin: string | null, target: string): void {
    if (origin !== null) returns.push(origin);
    onJumpToEvent?.(target, origin);
  }
  function jumpDown(): void {
    const eventId = returns.eventId;
    if (eventId === null || !onJumpToEvent) {
      jumpToLatest();
      return;
    }
    returns.popThrough(eventId);
    jumpFocusId = eventId;
    onJumpToEvent(eventId);
  }
  function jumpToMention(): void {
    const eventId = mentions.next((target) => entryFor(target) !== undefined);
    if (eventId === null) return;
    jumpFocusId = eventId;
    onJumpToEvent?.(eventId);
  }
  function jumpToLatest(): void {
    returns.clear();
    focus.cancel();
    unreadNavigation?.abort();
    historyController.finishHistoryFill();
    if (timeline.canResumeLive) {
      retryLive();
      return;
    }
    if (!live) {
      onJumpToLive?.();
      return;
    }
    unread.reachLatest();
    onReturnedToLatest?.();
    void controller?.jumpTo(null, 'start', !shouldReduceMotion());
  }
  function onJumpShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || isComposingKey(event) || !active) return;
    if (isEditableTarget(event.target) || isDialogOpen()) return;
    const mac = isMacPlatform();
    const pressed = (id: string): boolean => {
      const binding = bindingFor(id);
      return binding !== undefined && matchesBinding(binding, event, mac);
    };
    if (pressed('room.nextMention') && mentions.pending.length > 0) {
      event.preventDefault();
      jumpToMention();
    } else if (pressed('room.jumpBack') && returns.eventId !== null) {
      event.preventDefault();
      jumpDown();
    }
  }
  function onEscape(event: KeyboardEvent): void {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !active ||
      (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]'))
    ) {
      return;
    }
    if (selection.active) {
      event.preventDefault();
      selectionBar?.cancelOrClear();
      return;
    }
    if (!onMarkRead) return;
    event.preventDefault();
    jumpToLatest();
    if (unread.active || hasUnread) {
      void markAllRead();
    } else {
      dismissUnread();
    }
  }
</script>

{#snippet timelineItem(item: TimelineItemView, collapsed = false, unreadCount = 0)}
  {@const edited = editEventId !== null && item.event_id === editEventId}
  <TimelineItem
    {item}
    {collapsed}
    {unreadCount}
    replyPersona={item.in_reply_to ? personas(item.in_reply_to.event_id) : null}
    threadPersona={item.thread_summary ? personas(item.thread_summary.latest_event_id) : null}
    highlighted={item.event_id !== null &&
      item.event_id !== replayingEventId &&
      item.event_id === (focusEventId ?? landedEventId)}
    selected={replyEventId !== null && item.event_id === replyEventId}
    editing={edited}
    editor={edited ? inlineEditor : undefined}
    {...callbacks}
    {currentUserId}
    {canRedactOwn}
    {canRedactOthers}
    {canPin}
    {encrypted}
    {members}
    layout={preferences.layout}
    alignOwn={preferences.alignOwnMessages}
    avatarsInHeaders={preferences.avatarsInMessageHeaders}
    onJumpToEvent={onJumpToEvent && ((target: string) => jumpFrom(item.event_id, target))}
    {events}
    onMenuOpenChange={setMenuOpen}
    {roomId}
  />
{/snippet}

<svelte:window
  onkeydown={(event) => {
    onJumpShortcut(event);
    onEscape(event);
  }}
/>

<TimelineReadReceipt
  {timeline}
  visibleEventId={readPosition.eventId}
  enabled={reading && !unread.blocking && !markingRead && !timeline.resumingLive}
  {atLatest}
  onRead={markRead}
/>
<TimelineAnnouncements {timeline} {visibleItems} atLiveEdge={atLatest} />
<MessageContextMenu menu={messageMenu} />
<MessageDialogHost
  {dialogs}
  {events}
  {roomId}
  {members}
  {currentUserId}
  readers={(item) => readersByItem.get(item.id) ?? item.read_by}
  receiptTimestamps={(item) => receiptTimestampsByItem.get(item.id) ?? item.read_timestamps}
  {canRedactOwn}
  {canRedactOthers}
  onMatrixLink={callbacks.onMatrixLink}
  onSenderProfile={callbacks.onSenderProfile}
  onToggleReaction={callbacks.onToggleReaction}
  onReply={callbacks.onReply}
  onOpenThread={callbacks.onOpenThread}
  onDelete={callbacks.onDelete}
/>

{#if timeline.error && !emptyFailure}
  <Alert class="timeline-error" variant="critical" role="alert">
    {i18n.t('timeline.loadFailed')}
    {#if onRetryLoad}
      <Button type="button" onclick={() => void onRetryLoad?.()}>{i18n.t('common.tryAgain')}</Button
      >
    {/if}
  </Alert>
{/if}
{#if resumeFailed}
  <Alert variant="critical" role="alert">
    {i18n.t('timeline.loadFailed')}
    <Button type="button" onclick={retryLive}>{i18n.t('common.tryAgain')}</Button>
  </Alert>
{/if}

<div
  class={['timeline-content', `spacing-${preferences.messageSpacing}`]}
  style={timelineLayoutStyle(preferences.messageSpacing)}
  {@attach attachTimelineKeys}
>
  <p class="screen-reader-only" role="status" aria-live="polite" aria-atomic="true">
    {selectionAnnouncement}
  </p>
  {#if selection.active}
    <MessageSelectionBar
      bind:this={selectionBar}
      {selection}
      {events}
      {roomId}
      {threadRootId}
      {members}
      {selectableCount}
      canEdit={callbacks.onEdit !== undefined}
      canDelete={callbacks.onDelete !== undefined}
      {canRedactOwn}
      {canRedactOthers}
      onExit={exitSelection}
    />
  {:else if revealed && unread.active && !unread.loading && (!unreadInView || unreadError !== null)}
    <div class="unread-float">
      <div class="unread-bar">
        <Button
          class="jump-to-unread"
          variant="ghost"
          loading={jumpingUnread}
          disabled={markingRead}
          aria-label={i18n.t('timeline.jumpToUnread')}
          onclick={() => void jumpToUnread()}
        >
          <ArrowUpIcon />
          <span
            >{unreadCount > 0
              ? i18n.t('timeline.unreadCount', { count: unreadCount })
              : i18n.t('timeline.newMessagesUnknown')}</span
          >
          <span class="unread-action">{i18n.t('timeline.jumpToUnread')}</span>
        </Button>
        {#if onMarkRead}
          <Button variant="ghost" loading={markingRead} onclick={() => void markAllRead()}>
            <span>{i18n.t('common.markAsRead')}</span>
            <CheckIcon />
          </Button>
        {/if}
      </div>
      {#if unreadError !== null}
        <Alert variant="critical" role="alert"
          >{i18n.t(
            unreadError === 'jump' ? 'timeline.unreadJumpFailed' : 'timeline.markReadFailed'
          )}</Alert
        >
      {/if}
    </div>
  {/if}

  <div class="timeline-stage">
    <ChatBackground {roomId} />
    {#if historyLoadingVisible}
      <div
        class="timeline-loading history-loading"
        role="status"
        out:fade={{
          duration: motionMs(TIMELINE_LAYOUT.historyLoadingFade),
        }}
      >
        <Spinner />
        <span class="screen-reader-only">{i18n.t('timeline.loadingHistory')}</span>
      </div>
    {/if}
    {#if futureLoading}
      <div
        class="timeline-loading future-loading"
        role="status"
        out:fade={{
          duration: motionMs(TIMELINE_LAYOUT.historyLoadingFade),
        }}
      >
        <Spinner />
        <span class="screen-reader-only">{i18n.t('timeline.loadingNewer')}</span>
      </div>
    {/if}
    <div class={['timeline-viewport', { initial: !revealed && !preview }]}>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={viewport}
        class="viewport"
        aria-label={i18n.t('timeline.label')}
        aria-busy={timeline.backwardPagination === 'loading' || futureLoading}
        tabindex="-1"
        onkeydown={feedKeydown}
        {@attach mountWindow}
        {@attach feedItems}
        {@attach userScrollMarker}
        {@attach scrollLock(scrollLocked || menuOpen)}
        {@attach dismissKeyboardOnScroll}
        {@attach keepKeyboardOnTap}
        role="feed"
      >
        <div class={['items', `layout-${preferences.layout}`]}>
          <div class="window-rows">
            {#each rows as row (row.key)}
              {@const { item, group, collapsed, groupStart } = row.value}
              <div
                class={['item', { collapsed, 'group-start': groupStart }]}
                data-event-id={item.event_id ?? undefined}
                data-item-id={item.id}
                data-index={row.index}
                data-timeline-key={row.key}
              >
                {#if threadRootId && item.event_id === threadRootId}
                  <p class="thread-original">{i18n.t('timeline.originalMessage')}</p>
                {/if}
                {#if timelineStart && item.content.kind === 'timeline_start'}
                  {@render timelineStart()}
                {:else if group && row.value.kind === 'before_join'}
                  <TimelineBeforeJoinGroup items={group} renderItem={timelineItem} />
                {:else if group}
                  <TimelineMemberGroup
                    items={group}
                    {members}
                    onSenderProfile={callbacks.onSenderProfile}
                    renderItem={timelineItem}
                  />
                {:else}
                  {@render timelineItem(item, collapsed, row.value.unreadCount)}
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>

    {#if ((!revealed && !preview) || (awaitingContent && rows.length === 0)) && !noHistory}
      <TimelineSkeleton layout={preferences.layout} />
    {:else if emptyFailure && timeline.mode.kind === 'focused'}
      <EmptyState
        class="timeline-empty"
        title={i18n.t('timeline.focusFailed')}
        description={i18n.t('timeline.focusFailedHint')}
      >
        {#snippet actions()}
          {#if onReturnToPosition}
            <Button type="button" onclick={onReturnToPosition}>{i18n.t('common.back')}</Button>
          {/if}
          {#if onJumpToLive}
            <Button type="button" onclick={onJumpToLive}>{i18n.t('timeline.jumpToLatest')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else if emptyFailure}
      <EmptyState class="timeline-empty" title={i18n.t('timeline.loadFailed')}>
        {#snippet actions()}
          {#if onRetryLoad}
            <Button onclick={() => void onRetryLoad?.()}>{i18n.t('common.tryAgain')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else if visibleItems.length === 0}
      <EmptyState
        class="timeline-empty"
        title={timeline.items.length > 0
          ? i18n.t('timeline.allFiltered')
          : i18n.t('timeline.noMessages')}
        description={timeline.items.length > 0 ? i18n.t('timeline.allFilteredHint') : undefined}
      />
    {/if}
  </div>

  {#if revealed && visibleItems.length > 0}
    <div class="timeline-jumps" bind:this={jumps}>
      {#if mentions.pending.length > 0 && onJumpToEvent}
        {@const mentionLabel = i18n.t('timeline.jumpToMention', {
          count: mentions.pending.length,
        })}
        <div
          class="jump-to-mention-motion"
          in:fly={{ y: 4, duration: motionMs(200), easing: cubicOut }}
          out:fade={{ duration: motionMs(MOTION_MS.quick) }}
        >
          <Tooltip label={mentionLabel}>
            {#snippet trigger({ props })}
              <IconButton
                {...props}
                type="button"
                class="jump-to-mention"
                variant="secondary"
                size="medium"
                label={mentionLabel}
                aria-busy={mentions.jumping}
                onclick={jumpToMention}
              >
                {#if mentions.jumping}<Spinner />{:else}<AtIcon />{/if}
              </IconButton>
            {/snippet}
          </Tooltip>
          <UnreadBadge
            class="mention-count"
            counts={{ unread: 0, highlight: mentions.pending.length }}
            aria-hidden="true"
          />
        </div>
      {/if}
      <div class="jump-to-latest-slot">
        {#if live ? jumpToLatestVisible || returns.eventId !== null : onJumpToLive !== undefined}
          {@const jumpLabel = i18n.t(
            returns.eventId === null ? 'timeline.jumpToLatest' : 'timeline.jumpBack'
          )}
          <div
            class="jump-to-latest-motion"
            in:fly={{ y: 4, duration: motionMs(200), easing: cubicOut }}
            out:fade={{ duration: motionMs(MOTION_MS.quick) }}
          >
            <Tooltip label={jumpLabel}>
              {#snippet trigger({ props })}
                {#if returns.eventId === null}
                  <IconButton
                    {...props}
                    type="button"
                    class="jump-to-latest"
                    variant="secondary"
                    size="medium"
                    label={jumpLabel}
                    onclick={jumpDown}
                  >
                    <ArrowDownIcon />
                  </IconButton>
                {:else}
                  <Button
                    {...props}
                    type="button"
                    class="jump-to-latest jump-back"
                    variant="secondary"
                    aria-label={jumpLabel}
                    onclick={jumpDown}
                  >
                    <ArrowUDownLeftIcon class="mirror-rtl" aria-hidden="true" />
                    {i18n.t('common.back')}
                  </Button>
                {/if}
              {/snippet}
            </Tooltip>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if typingUsers.length > 0 || footTrailingVisible}
    <div class="timeline-foot">
      <TypingIndicator users={typingUsers} onProfile={callbacks.onSenderProfile} />
      {#if footTrailing && footTrailingVisible}
        <div class="foot-trailing">{@render footTrailing()}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .thread-original {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-200) var(--page-gutter) var(--space-100);
  }

  :global(.timeline-error) {
    flex: 0 0 auto;
    font-size: var(--font-size-small);
  }

  .timeline-content {
    --timeline-foot-height: var(--size-x300);
    --timeline-indicator-size: var(--target-hit);
    --timeline-scrollbar-size: 0.5rem;

    display: flex;
    flex: 1;
    flex-direction: column;
    isolation: isolate;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  @media (--app-layout) and (any-hover: hover) and (any-pointer: fine) {
    .timeline-content {
      --line-height-body: 1.47;
    }
  }

  .timeline-stage {
    display: flex;
    flex: 1;
    flex-direction: column;
    isolation: isolate;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .timeline-viewport {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .timeline-loading {
    align-items: center;
    background: var(--surface-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: 50%;
    box-shadow: var(--shadow-e200);
    color: var(--surface-on-container);
    display: flex;
    height: var(--timeline-indicator-size);
    justify-content: center;
    padding: var(--space-100);
    pointer-events: none;
    position: absolute;
    width: var(--timeline-indicator-size);
    z-index: 1;
  }

  .history-loading {
    inset-block-start: var(--space-200);
    /* stylelint-disable-next-line csstools/use-logical -- centred, so the same in both directions */
    left: 50%;
    transform: translateX(-50%);
  }

  .future-loading {
    inset-block-end: var(--space-200);
    /* stylelint-disable-next-line csstools/use-logical -- centred, so the same in both directions */
    left: 50%;
    transform: translateX(-50%);
  }

  .timeline-viewport.initial {
    visibility: hidden;
  }

  .viewport {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    overflow-anchor: none;
    overscroll-behavior-y: contain;
  }

  @supports not selector(::-webkit-scrollbar) {
    .viewport {
      scrollbar-color: var(--surface-var-container-line) transparent;
      scrollbar-width: thin;
    }
  }

  .viewport:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }

  .viewport::-webkit-scrollbar {
    height: var(--timeline-scrollbar-size);
    width: var(--timeline-scrollbar-size);
  }

  .viewport::-webkit-scrollbar-thumb {
    background: var(--surface-var-container-line);
    border-radius: var(--radius-pill);
  }

  .viewport::-webkit-scrollbar-track {
    background: transparent;
  }

  .items {
    --timeline-media-fill: 100%;
    --timeline-bubble-width: 100%;

    flex: 0 0 auto;
    margin-top: auto;
    min-width: 0;
    position: relative;
    width: 100%;
  }

  .window-rows {
    padding-block-end: var(--timeline-foot-height);
  }

  @media (width >= 30rem) {
    .items {
      --timeline-media-fill: var(--timeline-media-max);
      --timeline-bubble-width: fit-content;
    }
  }

  .item {
    box-sizing: border-box;
    padding: var(--timeline-row-padding) var(--page-gutter);
    width: 100%;
  }

  .item.collapsed {
    padding-top: 0;
  }

  .item.group-start {
    padding-top: calc(var(--timeline-row-padding) + var(--timeline-group-gap));
  }

  .layout-compact .item {
    padding-top: 0;
  }

  .layout-bubble .item {
    padding-bottom: 0;
  }

  .unread-float {
    background: var(--surface-container);
    inset-block-start: 0;
    inset-inline: 0 var(--timeline-scrollbar-size);
    position: absolute;
    z-index: 2;
  }

  .unread-bar {
    align-items: center;
    background: var(--primary-container);
    color: var(--primary-on-container);
    display: flex;
    flex: none;
    gap: var(--space-100);
    justify-content: space-between;
    padding-inline: var(--space-100);
  }

  .unread-bar :global(.btn) {
    --button-container: transparent;
    --button-line: transparent;
    --button-on-container: var(--primary-on-container);
    --button-container-hover: var(--primary-container-hover);
    --button-container-active: var(--primary-container-active);

    min-width: 0;
    white-space: normal;
  }

  .unread-bar :global(.jump-to-unread) {
    flex: 1;
    justify-content: flex-start;
  }

  .unread-action {
    margin-inline-start: auto;
  }

  @media (--compact-layout) {
    .unread-action {
      display: none;
    }
  }

  .timeline-foot {
    align-items: center;
    background: var(--surface-container);
    display: flex;
    gap: var(--space-200);
    height: var(--timeline-foot-height);
    inset-block-end: 0;
    inset-inline: 0 var(--timeline-scrollbar-size);
    justify-content: space-between;
    padding: 0 var(--page-gutter);
    position: absolute;
    z-index: 1;
  }

  .foot-trailing {
    flex: none;
  }

  .timeline-jumps {
    align-items: center;
    inset-inline: 0;
    bottom: calc(var(--timeline-foot-height) + var(--space-200));
    display: flex;
    gap: var(--space-200);
    margin-inline: auto;
    pointer-events: none;
    position: absolute;
    width: fit-content;
    z-index: 4;
  }

  .jump-to-mention-motion {
    pointer-events: auto;
    position: relative;
  }

  /* Kept empty while the control is away so the mention control never moves. */
  .jump-to-latest-slot {
    display: flex;
    height: var(--timeline-indicator-size);
    min-width: var(--timeline-indicator-size);
  }

  .jump-to-latest-motion {
    pointer-events: auto;
  }

  .jump-to-mention-motion :global(.mention-count) {
    inset-block-start: calc(var(--space-100) * -1);
    inset-inline-end: calc(var(--space-100) * -1);
    position: absolute;
  }

  :global(button.jump-to-latest),
  :global(button.jump-to-mention) {
    --button-height: var(--timeline-indicator-size);
    --button-container: var(--surface-var-container);
    --button-container-hover: var(--surface-var-container-hover);
    --button-container-active: var(--surface-var-container-active);
    --button-line: var(--surface-var-container-line);
    --button-on-container: var(--surface-var-on-container);

    background-image: none;
    border-radius: 50%;
    box-shadow: var(--shadow-float);
  }

  :global(button.btn.jump-back) {
    border-radius: var(--radii-pill);
    border-width: var(--border-width);
  }
</style>
