<script lang="ts">
  import type { ResolvedItem, ResolvedRow } from '#lib/rooms/timeline-item.js';
  import { page } from '$app/state';
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import type { MemberView, PerMessageProfileView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { dismissKeyboardOnScroll } from '#lib/platform/keyboard.js';
  import { windowActivity } from '#lib/platform/window-activity.js';
  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { MOTION_MS, motionMs, shouldReduceMotion } from '#lib/ui/motion.js';
  import {
    TimelineWindow,
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
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { isEditableTarget } from '#lib/ui/shortcuts/binding.js';

  import MessageContextMenu from '../messages/MessageContextMenu.svelte';
  import MessageDialogHost from '../messages/MessageDialogHost.svelte';
  import { useEventItems } from '../messages/event-items.svelte.js';
  import { MessageDialogs, provideMessageDialogs } from '../messages/message-dialogs.svelte.js';
  import { OpenMessageMenu, provideMessageMenu } from '../messages/message-menu-open.svelte.js';
  import { LoadRetry } from './load-retry';
  import TimelineItem from './TimelineItem.svelte';
  import TimelineMemberGroup from './TimelineMemberGroup.svelte';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';
  import TimelineAnnouncements from './TimelineAnnouncements.svelte';
  import TimelineSkeleton from './TimelineSkeleton.svelte';
  import TypingIndicator, { type TypingUser } from './TypingIndicator.svelte';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { TimelineEventIndex } from './timeline-event-index';
  import { personaLookup, replyTarget, type ReplyDirection } from './timeline-format';
  import { TimelinePagination } from './timeline-pagination.svelte.js';
  import { TimelineFocus } from './timeline-focus.svelte.js';
  import { TimelineFuture } from './timeline-future.svelte.js';
  import { GAP_ROW } from './timeline-gap';
  import { TimelineHistoryController } from './timeline-history';
  import {
    estimatedColumnPx,
    estimateRowSize,
    mediaColumnPx,
    TIMELINE_LAYOUT,
    timelineLayoutStyle,
  } from './timeline-layout';

  import type { MessageCallbacks } from '../messages/message-action-controller.svelte.js';

  interface Props extends MessageCallbacks {
    timeline: RoomTimeline;
    focusEventId?: string | null;
    landingEventId?: string | null;
    replyEventId?: string | null;
    editEventId?: string | null;
    inlineEditor?: Snippet;
    onLanded?: () => void;
    onRequestHistory: (count?: number) => Promise<boolean>;
    onRequestFuture: () => Promise<void>;
    onRetryLoad?: () => Promise<void>;
    threadRootId?: string | null;
    onRead: (eventId: string, fullyRead: boolean) => Promise<void>;
    onFullyRead?: (roomId: string, eventId: string) => void;
    hasUnread?: boolean;
    onRequestUnread?: (eventId: string) => Promise<void>;
    onResumeLive?: () => Promise<void>;
    onMarkRead?: () => Promise<void>;
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
    roomId?: string;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
    onJumpToLive?: () => void;
    onOpenMedia?: (eventId: string) => void;
    onVotePoll?: (eventId: string, answers: string[]) => void;
    onEndPoll?: (eventId: string) => void;
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
    onRequestHistory,
    onRequestFuture,
    onRetryLoad,
    threadRootId = null,
    onRead,
    onFullyRead,
    hasUnread = false,
    onRequestUnread,
    onResumeLive,
    onMarkRead,
    onMatrixLink,
    onCopyLink,
    onMarkUnread,
    onSenderProfile,
    onMentionUser,
    onRetrySend,
    onCancelSend,
    currentUserId,
    onToggleReaction,
    onReply,
    onCancelContext,
    onOpenThread,
    onEdit,
    onDelete,
    roomId,
    members = [],
    onJumpToEvent,
    onJumpToLive,
    onOpenMedia,
    onVotePoll,
    onEndPoll,
    readOnly = false,
    canRedactOwn = true,
    canRedactOthers = false,
    canPin = true,
    encrypted = null,
    active = true,
    scrollLocked = false,
    nearLatest = $bindable(true),
    /* eslint-disable-next-line no-useless-assignment, @typescript-eslint/no-unused-vars */
    followingLive = $bindable(false),
    typingUsers = [],
    footTrailing,
    footTrailingVisible = false,
    timelineStart,
  }: Props = $props();

  $effect(() => {
    timeline.show({ readOnly, threadRoot: threadRootId });
  });

  const dialogs = provideMessageDialogs(new MessageDialogs());
  const messageMenu = provideMessageMenu(new OpenMessageMenu());

  type RowValue = ResolvedRow;
  let unreadNavigation: AbortController | null = null;
  let jumpingUnread = $state(false);
  let markingRead = $state(false);
  let unreadError = $state<'jump' | 'read' | null>(null);
  let switchingToUnread = false;
  let resumeTask: Promise<void> | null = null;
  let resumeFailed = $state(false);
  let reading = $derived(active && page.state.settings === undefined);
  const readRoomId = untrack(() => roomId);
  let readUpTo: string | null = null;
  let fullyReadAt: string | null = null;
  function settleFullyRead(): void {
    if (!readRoomId || !onFullyRead || readUpTo === null || readUpTo === fullyReadAt) return;
    fullyReadAt = readUpTo;
    onFullyRead(readRoomId, readUpTo);
  }
  $effect(() => {
    if (!windowActivity.active) untrack(settleFullyRead);
  });
  const loadRetry = new LoadRetry();
  onDestroy(() => {
    unreadNavigation?.abort();
    settleFullyRead();
    loadRetry.reset();
  });
  /** Stands for a row the runtime has not sent: the list keeps its place while the rows come. */
  const gaps: TimelineEntry<RowValue>[] = [];
  function gapAt(index: number): TimelineEntry<RowValue> {
    return (gaps[index] ??= { key: `gap:${String(index)}`, value: GAP_ROW });
  }
  const entryCache = new WeakMap<ResolvedRow, TimelineEntry<RowValue>>();
  function entryOf(row: ResolvedRow): TimelineEntry<RowValue> {
    let entry = entryCache.get(row);
    if (!entry) {
      entry = { key: row.key, value: row };
      entryCache.set(row, entry);
    }
    return entry;
  }
  let listedRows: readonly ResolvedRow[] = [];
  let listedEntries: readonly TimelineEntry<RowValue>[] = [];
  let listedFirst = 0;
  let entries = $derived.by(() => {
    const listed = timeline.rows;
    const first = timeline.first;
    if (listed !== listedRows || first !== listedFirst) {
      listedRows = listed;
      listedFirst = first;
      listedEntries = [
        ...Array.from({ length: first }, (_, index) => gapAt(index)),
        ...listed.map(entryOf),
      ];
    }
    return listedEntries;
  });
  let visibleCount = $derived(timeline.total);
  let unread = $derived(timeline.unread);
  let events = $derived(new TimelineEventIndex(timeline.items, timeline.aggregations));
  function holdsEvent({ item, group }: RowValue, eventId: string | null): boolean {
    if (eventId === null) return false;
    return (
      item.event_id === eventId ||
      (group?.some((member) => member.item.event_id === eventId) ?? false)
    );
  }
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
  let receiptsByItem = $derived(
    new Map(
      timeline.rows.flatMap((row) => (row.receipts ? [[row.item.id, row.receipts] as const] : []))
    )
  );
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
    visibleCount === 0 && (pagination.exhausted || timeline.backwardPagination === 'end')
  );
  let awaitingContent = $derived(visibleCount === 0 && timeline.error === null && !noHistory);
  let emptyFailure = $derived(visibleCount === 0 && timeline.error !== null);
  $effect(() => {
    if (visibleCount > 0) {
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
  let newestShown = $derived.by(() => {
    if (!revealed || !viewport) return null;
    if (windowState.pinned) {
      if (timeline.latestEventId !== null) return timeline.latestEventId;
      for (let index = windowState.rows.length - 1; index >= 0; index -= 1) {
        const eventId = windowState.rows[index].value.item.event_id;
        if (eventId) return eventId;
      }
      return null;
    }
    if (windowState.lastFullyVisible === null) return null;
    for (let index = windowState.rows.length - 1; index >= 0; index -= 1) {
      const row = windowState.rows[index];
      if (row.index <= windowState.lastFullyVisible && row.value.item.event_id)
        return row.value.item.event_id;
    }
    return null;
  });
  let readEventId = $derived(unread.blocking || markingRead ? null : newestShown);
  let unreadCount = $derived(unread.count);
  let unreadInView = $derived.by(() => {
    const index = entries.findIndex(({ value }) => holdsEvent(value, unread.first_event_id));
    return (
      index >= 0 &&
      windowState.firstVisible !== null &&
      windowState.lastVisible !== null &&
      index >= windowState.firstVisible &&
      index <= windowState.lastVisible
    );
  });
  $effect(() => {
    const focused = windowActivity.active && !windowActivity.recentlyResumed;
    const newest = reading && revealed && !jumpingUnread ? newestShown : null;
    if (opened) timeline.viewing(focused, newest);
    if (reading && revealed && focused && unreadInView)
      timeline.observeUnread(unread.first_event_id);
  });
  let holdAtLatest = $state(untrack(() => !preferences.openRoomsAtUnread));
  $effect(() => {
    if (unread.initialized) timeline.roomUnread(hasUnread, holdAtLatest);
  });
  let historyLoading = $derived(
    revealed &&
      visibleCount > 0 &&
      (pagination.pending || timeline.backwardPagination === 'loading')
  );
  let live = $derived(timeline.mode.kind === 'live');
  let futureLoading = $derived(
    revealed && !live && visibleCount > 0 && timeline.forwardPagination === 'loading'
  );
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
    windowState = state;
    timeline.cover(state.start, !state.scrolling);
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
    if (wasScrolling && !state.scrolling) historyController.onScrollSettled();
  }
  function readerScrolled(delta: number): void {
    historyController.clearUserScrollPending();
    if (!revealed) return;
    if (delta < 0) holdAtLatest = false;
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
      canFollowLatest: () => untrack(() => timeline.reachesLatest),
    });
    controller = engine;
    return () => {
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
    const loading = timeline.loading || (!timeline.hasSnapshot && !timeline.error);
    if (!engine) return;
    void engine.update(next).then(() => {
      if (!loading && !disposed) void openTimeline(engine);
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
    const initializingUnread = timeline.initializeUnread(hasUnread).catch((error: unknown) => {
      console.warn('[sable timeline] starting the unread tracker failed', error);
    });
    const landingPending = landingEventId !== null && onRequestUnread !== undefined;
    if (
      !entries.some(({ value }) => value.item.content.kind === 'read_marker') &&
      !entryFor(landingEventId) &&
      !landingPending
    ) {
      revealed = true;
    }
    await initializingUnread;
    if (disposed) return;
    if (focusEventId) {
      const target = focusEventId;
      const entry = entryFor(focusEventId);
      if (entry) handledFocus = target;
      revealed = true;
      if (entry) await focus.position(engine, target, entry.key, false);
      return;
    }
    const landingEntry = () => entryFor(landingEventId);
    const unreadEntry = entries.find(({ value }) => value.item.content.kind === 'read_marker');
    if (!unreadEntry && !landingEntry() && !landingPending) revealed = true;
    filling = true;
    try {
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
          unread.first_event_id !== null &&
          !disposed
        ) {
          await jumpToUnread();
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
    const count = visibleCount;
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
      untrack(() => nearLatest)
    )
      void engine.jumpTo(null, 'start');
  });
  export function composerFocused(event: FocusEvent): void {
    if (!controller || !revealed || !isEditableTarget(event.target)) return;
    if (nearLatest && !windowState.pinned) void controller.jumpTo(null, 'start');
  }
  let handledFocus: string | null = null;
  let heldContext = $state<string | null>(null);
  $effect(() => {
    if (
      timeline.mode.kind !== 'unread' ||
      timeline.mode.event_id === heldContext ||
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
    if (timeline.mode.kind === 'unread') heldContext = timeline.mode.event_id;
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
    const fullyRead = !holdAtLatest && eventId === timeline.latestEventId;
    await onRead(eventId, fullyRead);
    if (!holdAtLatest) readUpTo = eventId;
    if (fullyRead) fullyReadAt = eventId;
    if (disposed) {
      settleFullyRead();
      return;
    }
    if (!holdAtLatest) timeline.read(eventId);
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
      await timeline.initializeUnread(hasUnread);
      if (unread.failed) {
        unreadError = 'jump';
        return;
      }
      if (
        current() &&
        !entryFor(unread.first_event_id) &&
        unread.read_event_id !== null &&
        onRequestUnread
      ) {
        switchingToUnread = true;
        try {
          await onRequestUnread(unread.read_event_id);
        } finally {
          switchingToUnread = false;
        }
        await flushed();
      }
      if (!current()) return;
      if (!unread.active) return;
      const target = entryFor(unread.first_event_id);
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
      if (!disposed) timeline.clearUnread();
    } catch (error) {
      console.warn('[sable timeline] mark as read failed', error);
      if (!disposed) unreadError = 'read';
    } finally {
      if (!disposed) markingRead = false;
    }
  }
  export function dismissUnread(): void {
    unreadNavigation?.abort();
    timeline.clearUnread();
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

  export function stepReply(direction: ReplyDirection): string | null {
    const target = replyTarget(timeline.rows, replyEventId, direction);
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
  function jumpToLatest(): void {
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
    holdAtLatest = false;
    void controller?.jumpTo(null, 'start', !shouldReduceMotion());
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
      !onMarkRead ||
      (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]'))
    ) {
      return;
    }
    event.preventDefault();
    jumpToLatest();
    if (unread.active || hasUnread) {
      void markAllRead();
    } else {
      dismissUnread();
    }
  }
</script>

{#snippet timelineItem(item: ResolvedItem, collapsed = false, unreadCount = 0)}
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
    {onMatrixLink}
    {onCopyLink}
    {onMarkUnread}
    {onSenderProfile}
    {onMentionUser}
    {onRetrySend}
    {onCancelSend}
    {currentUserId}
    {onToggleReaction}
    {onReply}
    {onCancelContext}
    {onOpenThread}
    {onEdit}
    {onDelete}
    {canRedactOwn}
    {canRedactOthers}
    {canPin}
    {encrypted}
    {members}
    layout={preferences.layout}
    alignOwn={preferences.alignOwnMessages}
    avatarsInHeaders={preferences.avatarsInMessageHeaders}
    {onJumpToEvent}
    {onOpenMedia}
    {onVotePoll}
    {onEndPoll}
    {events}
    onMenuOpenChange={setMenuOpen}
    {roomId}
  />
{/snippet}

<svelte:window onkeydown={onEscape} />

<TimelineReadReceipt
  {timeline}
  visibleEventId={readEventId}
  enabled={reading && !unread.blocking && !markingRead && !timeline.resumingLive}
  atLatest={windowState.pinned && timeline.forwardPagination === 'end'}
  onRead={markRead}
/>
<TimelineAnnouncements {timeline} />
<MessageContextMenu menu={messageMenu} />
<MessageDialogHost
  {dialogs}
  {events}
  {roomId}
  {members}
  {currentUserId}
  readers={(item) => receiptsByItem.get(item.id)?.readers ?? item.read_by}
  receiptTimestamps={(item) => receiptsByItem.get(item.id)?.timestamps ?? item.read_timestamps}
  {canRedactOwn}
  {canRedactOthers}
  {onMatrixLink}
  {onSenderProfile}
  {onToggleReaction}
  {onReply}
  {onOpenThread}
  {onDelete}
/>

{#if timeline.error && !emptyFailure}
  <Alert class="timeline-error" variant="critical" role="alert"
    >{i18n.t('timeline.loadFailed')}</Alert
  >
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
>
  {#if revealed && unread.active && !unread.loading && (!unreadInView || unreadError !== null)}
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
  {/if}

  <div class="timeline-stage">
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
    <div class={['timeline-viewport', { initial: !revealed }]}>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        bind:this={viewport}
        class="viewport"
        aria-label={i18n.t('timeline.label')}
        tabindex="0"
        {@attach mountWindow}
        {@attach userScrollMarker}
        {@attach scrollLock(scrollLocked || menuOpen)}
        {@attach dismissKeyboardOnScroll}
        role="log"
        aria-live="off"
      >
        <div class={['items', `layout-${preferences.layout}`]}>
          <div class="window-rows">
            {#each rows as row (row.key)}
              {@const { item, group, collapsed, group_start: groupStart } = row.value}
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
                {#if row.value === GAP_ROW}
                  <div class="gap" aria-hidden="true"></div>
                {:else if timelineStart && item.content.kind === 'timeline_start'}
                  {@render timelineStart()}
                {:else if group}
                  <TimelineMemberGroup
                    items={group.map((member) => member.item)}
                    segments={row.value.segments}
                    {members}
                    {onSenderProfile}
                    renderItem={timelineItem}
                  />
                {:else}
                  {@render timelineItem(item, collapsed, row.value.unread_count)}
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>

    {#if (!revealed || (awaitingContent && rows.length === 0)) && !noHistory}
      <TimelineSkeleton layout={preferences.layout} />
    {:else if emptyFailure && timeline.mode.kind === 'focused'}
      <EmptyState
        class="timeline-empty"
        title={i18n.t('timeline.focusFailed')}
        description={i18n.t('timeline.focusFailedHint')}
      >
        {#snippet actions()}
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
    {:else if visibleCount === 0}
      <EmptyState
        class="timeline-empty"
        title={timeline.itemCount > 0
          ? i18n.t('timeline.allFiltered')
          : i18n.t('timeline.noMessages')}
        description={timeline.itemCount > 0 ? i18n.t('timeline.allFilteredHint') : undefined}
      />
    {/if}
  </div>

  {#if revealed && visibleCount > 0 && (live ? jumpToLatestVisible : onJumpToLive !== undefined)}
    {@const jumpLabel = i18n.t('timeline.jumpToLatest')}
    <div
      class="jump-to-latest-motion"
      in:fly={{ y: 4, duration: motionMs(200), easing: cubicOut }}
      out:fade={{ duration: motionMs(MOTION_MS.quick) }}
    >
      <Tooltip label={jumpLabel}>
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            type="button"
            class="jump-to-latest"
            variant="secondary"
            size="medium"
            label={jumpLabel}
            onclick={jumpToLatest}
          >
            <ArrowDownIcon />
          </IconButton>
        {/snippet}
      </Tooltip>
    </div>
  {/if}

  {#if typingUsers.length > 0 || footTrailingVisible}
    <div class="timeline-foot">
      <TypingIndicator users={typingUsers} onProfile={onSenderProfile} />
      {#if footTrailing && footTrailingVisible}
        <div class="foot-trailing">{@render footTrailing()}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .gap {
    block-size: var(--size-x300);
  }

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
    inset-inline-start: 50%;
    transform: translateX(-50%);
  }

  .future-loading {
    inset-block-end: var(--space-200);
    inset-inline-start: 50%;
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

  .jump-to-latest-motion {
    inset-inline: 0;
    bottom: calc(var(--timeline-foot-height) + var(--space-200));
    margin-inline: auto;
    position: absolute;
    width: fit-content;
    z-index: 4;
  }

  :global(button.jump-to-latest) {
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
</style>
