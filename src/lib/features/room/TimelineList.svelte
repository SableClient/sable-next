<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import { get } from 'svelte/store';
  import { createVirtualizer } from '@tanstack/svelte-virtual';

  import type { MemberView } from '#src/generated/MemberView';
  import type { TimelineItemView } from '#src/generated/TimelineItemView';
  import { i18n } from '#lib/i18n.js';
  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  import TimelineItem from './TimelineItem.svelte';
  import type { MatrixLink } from './matrix-link';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import TimelineSkeleton from './TimelineSkeleton.svelte';
  import { TimelineHistoryController } from './timeline-history';
  import { TimelineIdentityTracker } from './timeline-identity';
  import {
    ANCHOR_EPSILON,
    anchorKeyForItem,
    domAnchorViewport,
    TimelineAnchor,
    type AnchorViewport,
  } from './timeline-anchor';
  import {
    estimateTimelineItemSize,
    rootFontSize,
    TIMELINE_LAYOUT,
    TIMELINE_LAYOUT_STYLE,
  } from './timeline-layout';
  import {
    TimelineDebugRecorder,
    timelineDebugEnabled,
    timelineDebugSnapshot,
    type TimelineDebugSample,
  } from './timeline-debug';
  import {
    initialPosition,
    isNearLatest,
    nextPosition,
    type TimelinePosition,
  } from './timeline-position';
  import {
    hasNewLocalEcho,
    isCollapsed,
    latestEventId,
    personaLookup,
    unreadCountAfter,
    visibleTimelineItems,
  } from './timeline-format';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MessageContextMenu from './MessageContextMenu.svelte';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';
  import TypingIndicator from './TypingIndicator.svelte';

  interface Props {
    timeline: RoomTimeline;
    focusEventId?: string | null;
    onRequestHistory: () => Promise<boolean>;
    onRequestFuture: () => Promise<void>;
    onRead: (eventId: string) => Promise<void>;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onCopyLink?: (eventId: string) => void;
    onMarkUnread?: (eventId: string) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onMentionUser?: (userId: string, name: string) => void;
    onRetrySend?: (transactionId: string) => void;
    onCancelSend?: (transactionId: string) => void;
    currentUserId?: string | null;
    onToggleReaction?: (eventId: string, key: string) => void;
    onReply?: (eventId: string) => void;
    onOpenThread?: (rootEventId: string) => void;
    onEdit?: (eventId: string, body: string, html: string | null) => void;
    onDelete?: (eventId: string, reason: string | null) => void;
    roomId?: string;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
    onOpenMedia?: (eventId: string) => void;
    onVotePoll?: (eventId: string, answers: string[]) => void;
    onEndPoll?: (eventId: string) => void;
    readOnly?: boolean;
    canRedactOthers?: boolean;
    scrollLocked?: boolean;
    nearLatest?: boolean;
    followingLive?: boolean;
    typingLabel?: string | null;
    footTrailing?: Snippet;
  }

  type TimelineRenderRow =
    | { kind: 'history' }
    | { kind: 'item'; item: TimelineItemView; itemIndex: number };

  const HISTORY_ROW_KEY = 'history-placeholder';

  let {
    timeline,
    focusEventId = null,
    onRequestHistory,
    onRequestFuture,
    onRead,
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
    onOpenThread,
    onEdit,
    onDelete,
    roomId,
    members = [],
    onJumpToEvent,
    onOpenMedia,
    onVotePoll,
    onEndPoll,
    readOnly = false,
    canRedactOthers = false,
    scrollLocked = false,
    nearLatest = $bindable(true),
    /* The parent reads this through its binding, which eslint cannot see. */
    /* eslint-disable-next-line no-useless-assignment */
    followingLive = $bindable(false),
    typingLabel = null,
    footTrailing,
  }: Props = $props();
  let visibleItems = $derived(visibleTimelineItems(timeline.items, preferences, { readOnly }));
  /* The paginate call's own answer, as well as the store's: that only settles to
     `end` on a two-second timeout when a page moves no boundary. */
  let historyExhausted = $state(false);
  let historyRequestPending = $state(false);
  let noHistory = $derived(
    visibleItems.length === 0 && (historyExhausted || timeline.backwardPagination === 'end')
  );
  let personas = $derived(personaLookup(timeline.items));
  let personaOpen = $state(false);

  // Reading down through unread history marks what has gone past the fold, not
  // only what is on screen when the reader reaches the end.
  let readEventId = $derived.by(() => {
    if (position.kind === 'pinned') return latestEventId(timeline.items);
    const bottom = ($virtualizer.scrollOffset ?? 0) + (viewport?.clientHeight ?? 0);
    let seen: string | null = null;
    for (const row of $virtualizer.getVirtualItems()) {
      if (row.end > bottom) break;
      const rendered = renderRows[row.index];
      if (rendered?.kind === 'item') seen = rendered.item.event_id ?? seen;
    }
    return seen;
  });

  // Virtual rows are absolutely positioned, so the separator cannot be sticky
  // in flow; it is mirrored above once its own row has scrolled past the top.
  let readMarker = $derived.by(() => {
    const index = visibleItems.findIndex((item) => item.content.kind === 'read_marker');

    return index === -1
      ? null
      : { index: index + historyRowOffset, unread: unreadCountAfter(visibleItems, index) };
  });

  let stuckUnreadCount = $derived.by(() => {
    const marker = readMarker;
    if (marker === null) return 0;
    const top = $virtualizer.getVirtualItemForOffset($virtualizer.scrollOffset ?? 0);

    return top === undefined || marker.index >= top.index ? 0 : marker.unread;
  });

  // The mount-time target belongs to the anchoring effect below, so it starts
  // here as already handled.
  // svelte-ignore state_referenced_locally
  let smoothTarget: string | null = focusEventId;
  $effect(() => {
    const target = focusEventId;
    if (target === null) {
      smoothTarget = null;
      return;
    }
    if (target === smoothTarget) return;
    const index = visibleItems.findIndex((item) => item.event_id === target);
    if (index < 0) return;
    const offset = offsetOfIndex(index + historyRowOffset, 'center');
    if (offset === null) return;
    smoothTarget = target;
    setPosition({ kind: 'focused', eventId: target });
    focusAnchored = true;
    recordScroll('focus:smooth', viewport?.scrollTop ?? -1);
    viewport?.scrollTo({ top: offset, behavior: 'smooth' });
  });
  let viewport = $state<HTMLDivElement | null>(null);
  let initialFillState = $state<'idle' | 'running' | 'done'>('idle');
  let revealedBeforeFill = false;
  // `getComputedStyle` flushes style, so it is read per font scale, not per diff.
  let cachedRootFontSize = $state(rootFontSize());
  let initialFillPages = 0;
  let emptyRefillPages = 0;
  let emptyRefillPending = false;
  let openingBackfillState = $state<'idle' | 'running' | 'done'>('idle');
  let openingBackfillGeneration = 0;
  let hadVisibleItems = false;
  let virtualizerWasScrolling = false;
  let virtualizerTotalSize = 0;
  let virtualizerViewportSize = 0;
  let focusAnchored = false;
  // Only the mount-time target picks the mode; later ones go through the effect.
  // svelte-ignore state_referenced_locally
  let position = $state<TimelinePosition>(initialPosition(focusEventId));
  const HISTORY_PLACEHOLDER_REM = 14;
  const HISTORY_PLACEHOLDER_VIEWPORT_RATIO = 1 / 3;
  let measuredHistoryPlaceholderHeight = $state(0);
  let historyLoading = $derived(
    position.kind !== 'settling' &&
      visibleItems.length > 0 &&
      (openingBackfillState === 'running' ||
        historyRequestPending ||
        timeline.backwardPagination === 'loading')
  );
  let historyPlaceholderTargetHeight = $derived(
    historyLoading
      ? Math.max(
          HISTORY_PLACEHOLDER_REM * rootFontSize(),
          (viewport?.clientHeight ?? virtualizerViewportSize) * HISTORY_PLACEHOLDER_VIEWPORT_RATIO
        )
      : 0
  );
  let historyPlaceholderHeight = $derived(
    historyLoading ? Math.max(historyPlaceholderTargetHeight, measuredHistoryPlaceholderHeight) : 0
  );
  let historyRowOffset = $derived(historyLoading ? 1 : 0);
  let renderRows = $derived<TimelineRenderRow[]>([
    ...(historyLoading ? ([{ kind: 'history' }] as const) : []),
    ...visibleItems.map((item, itemIndex) => ({ kind: 'item' as const, item, itemIndex })),
  ]);
  function setPosition(next: TimelinePosition): void {
    position = next;
    followingLive = next.kind === 'pinned';
  }
  const initialItems: readonly TimelineItemView[] = [];
  const INITIAL_END_RECONCILIATION_LIMIT = 60;
  let initialEndReconciliationAttempts = 0;
  let initialEndReconciliationPending = false;
  let timelineDebugSample = $state<TimelineDebugSample | null>(null);
  const timelineDebugRecorder = new TimelineDebugRecorder();
  const identityTracker = new TimelineIdentityTracker();
  const timelineDebugEnabledForView = timelineDebugEnabled();
  let historyController: TimelineHistoryController;
  let configuredItems: readonly TimelineItemView[] = initialItems;
  let configuredRows: readonly TimelineRenderRow[] = [];
  let historyDebugChange = 0;

  let anchorHolding = false;
  let anchorCorrecting = false;
  let anchorHoldSequence = 0;
  let activeHoldId: number | null = null;
  function anchorRolling(): boolean {
    return !anchorHolding && anchor.held !== null;
  }
  let measurementRevision = 0;
  let anchorCorrection: { by: string; delta: number; key: string | null } | null = null;
  let selfWrite: { by: string; from: number; to: number; at: number } | null = null;
  function recordScroll(by: string, from: number, to?: number): void {
    if (!timelineDebugEnabledForView) return;
    selfWrite = { by, from, to: to ?? viewport?.scrollTop ?? -1, at: performance.now() };
  }
  let anchorResidual: number | null = 0;
  let expectedSelfOffset: number | null = null;
  function recordSelfWrite(): void {
    expectedSelfOffset = viewport?.scrollTop ?? null;
  }
  let anchorViewportCache: { node: HTMLDivElement; view: AnchorViewport } | null = null;
  function anchorViewport(): AnchorViewport | null {
    const node = viewport;
    if (!node) return null;
    if (anchorViewportCache?.node !== node) {
      const base = domAnchorViewport(node);
      anchorViewportCache = {
        node,
        view: {
          ...base,
          scrollBy: (delta) => {
            anchorCorrection = {
              by: anchorHolding ? 'hold' : 'rolling',
              delta,
              key: anchor.held?.key ?? null,
            };
            base.scrollBy(delta);
            recordSelfWrite();
          },
        },
      };
    }
    return anchorViewportCache.view;
  }
  const anchor = new TimelineAnchor(anchorViewport);
  let nearLatestPx = TIMELINE_LAYOUT.jumpToLatestRem * 16;
  let atLatest = $state(true);

  function refreshAtLatest(): void {
    atLatest = viewport !== null && isNearLatest(viewport, ANCHOR_EPSILON);
  }

  // The virtualiser's helpers arm `reconcileScroll`, which forces the offset back
  // to its own target for five seconds.
  function scrollToOffsetNow(offset: number, by: string): void {
    if (!viewport) return;
    const from = viewport.scrollTop;
    viewport.scrollTop = offset;
    recordSelfWrite();
    recordScroll(by, from);
  }

  function offsetOfIndex(index: number, align: 'start' | 'center' | 'end'): number | null {
    return get(virtualizer).getOffsetForIndex(index, align)?.[0] ?? null;
  }

  function currentViewport(): HTMLDivElement | null {
    return viewport;
  }

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    estimateSize: (index) =>
      estimateTimelineItemSize(initialItems, index, TIMELINE_LAYOUT.mediaMaxRem * 16, 16),
    getItemKey: (index) => identityTracker.key(initialItems, index),
    // `followOnAppend` only arms `reconcileScroll`, which forces the virtualiser's
    // own stale target back for five seconds.
    anchorTo: 'start',
    followOnAppend: false,
    scrollEndThreshold: 0,
    useScrollendEvent: true,
    overscan: 24,
    onChange: handleVirtualizerChange,
  });

  // A row above the reader is measured after Svelte has positioned it, so the
  // DOM anchor can only correct the shift a frame after it is painted. The
  // virtualiser knows the delta first. Unlike `followOnAppend`, the adjustment
  // sets no `scrollState`, so nothing arms `reconcileScroll`.
  get(virtualizer).shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    const offset = instance.scrollOffset;
    if (offset === null || item.start >= offset) return false;
    if (instance.itemSizeCache.has(item.key) && item.end > offset) return false;
    const from = viewport?.scrollTop ?? offset;
    expectedSelfOffset = from + delta;
    recordScroll('virtualizer:resize', from, expectedSelfOffset);
    return true;
  };

  $effect(() => {
    if (!historyLoading) measuredHistoryPlaceholderHeight = 0;
  });

  function setHistoryPlaceholderHeight(height: number): void {
    if (!historyLoading || Math.abs(height - measuredHistoryPlaceholderHeight) < 1) return;
    measuredHistoryPlaceholderHeight = height;
  }

  async function requestHistory(): Promise<boolean> {
    historyRequestPending = true;
    try {
      return await onRequestHistory();
    } finally {
      historyRequestPending = false;
    }
  }

  historyController = new TimelineHistoryController({
    getBackwardPagination: () => timeline.backwardPagination,
    isNearOldest: () => viewport !== null && viewport.scrollTop < viewport.clientHeight * 2,
    isVirtualizerScrolling: () => get(virtualizer).isScrolling,
    requestHistory,
    onGestureSettled: () => {
      if (!commitDeferred) return;
      commitDeferred = false;
      scheduleCommit();
    },
    debugLog: historyDebugLog,
    debugSnapshot: () => timelineDebugSnapshot(viewport, get(virtualizer), position.kind),
  });

  $effect(() => {
    if (!timelineDebugEnabledForView) return;
    let previousScrollTop: number | null = null;
    let previousScrollHeight: number | null = null;
    let previousTime: number | null = null;
    let previousAnchorKey: string | null = null;
    let previousAnchorTop: number | null = null;
    let maxFrameDuration = 0;
    let maxFrameDelta = 0;
    let maxVisualDelta = 0;
    let maxAnchorResidual = 0;
    let lastHudUpdate = 0;
    let frame = 0;
    const sample = (): void => {
      const activeViewport = viewport;
      if (activeViewport) {
        const time = performance.now();
        const instance = get(virtualizer);
        const virtualItems = instance.getVirtualItems();
        const scrollTop = activeViewport.scrollTop;
        const scrollHeight = activeViewport.scrollHeight;
        const viewportEnd = scrollTop + activeViewport.clientHeight;
        const anchor =
          virtualItems.find((item) => item.start >= scrollTop && item.end <= viewportEnd) ??
          virtualItems.find((item) => item.end > scrollTop);
        const anchorKey = anchor ? String(anchor.key) : null;
        const anchorTop = anchor ? anchor.start - scrollTop : null;
        const frameDuration = previousTime === null ? 0 : time - previousTime;
        const frameDelta = previousScrollTop === null ? 0 : scrollTop - previousScrollTop;
        const contentDelta =
          previousScrollHeight === null ? 0 : scrollHeight - previousScrollHeight;
        // A correction moves `scrollTop` on purpose, so requiring a still frame
        // blinded this to the only frames worth measuring.
        const visualDelta =
          (frameDelta === 0 || anchorHolding) &&
          anchorKey !== null &&
          anchorKey === previousAnchorKey &&
          previousAnchorTop !== null
            ? (anchorTop ?? previousAnchorTop) - previousAnchorTop
            : 0;
        previousTime = time;
        previousScrollTop = scrollTop;
        previousScrollHeight = scrollHeight;
        previousAnchorKey = anchorKey;
        previousAnchorTop = anchorTop;
        maxFrameDuration = Math.max(maxFrameDuration, frameDuration);
        maxFrameDelta = Math.max(maxFrameDelta, Math.abs(frameDelta));
        maxVisualDelta = Math.max(maxVisualDelta, Math.abs(visualDelta));
        maxAnchorResidual = Math.max(maxAnchorResidual, Math.abs(anchorResidual ?? 0));
        const nextSample: TimelineDebugSample = {
          time,
          scrollTop,
          scrollHeight,
          contentDelta,
          distanceFromEnd: scrollHeight - scrollTop - activeViewport.clientHeight,
          frameDuration,
          maxFrameDuration,
          frameDelta,
          maxFrameDelta,
          anchorKey,
          anchorTop,
          visualDelta,
          maxVisualDelta,
          anchorResidual,
          maxAnchorResidual,
          anchorGuard: anchorHolding ? 'hold' : anchorRolling() ? 'rolling' : 'none',
          anchorCorrection,
          selfWrite,
          firstVirtualIndex: virtualItems[0]?.index ?? null,
          lastVirtualIndex: virtualItems.at(-1)?.index ?? null,
          isScrolling: instance.isScrolling,
          scrollMode: position.kind,
          backwardPagination: timeline.backwardPagination,
        };
        timelineDebugRecorder.add(nextSample);
        if (time - lastHudUpdate >= 100) {
          lastHudUpdate = time;
          timelineDebugSample = timelineDebugRecorder.latest();
        }
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => {
      cancelAnimationFrame(frame);
    };
  });

  async function copyTimelineDebug(): Promise<void> {
    await timelineDebugRecorder.copyTrace();
  }

  function handleVirtualizerChange(): void {
    const instance = get(virtualizer);
    const totalSize = instance.getTotalSize();
    const viewportSize = instance.scrollRect?.height ?? 0;
    const contentSizeChanged = totalSize !== virtualizerTotalSize;
    const viewportSizeChanged = viewportSize !== virtualizerViewportSize;
    virtualizerTotalSize = totalSize;
    virtualizerViewportSize = viewportSize;
    refreshAtLatest();
    if (contentSizeChanged) measurementRevision += 1;
    if (contentSizeChanged) correctRollingAnchor();
    // `settling` is driven by the landing loop below, which commits and measures
    // in step; a second committer racing it re-enters mid-measurement.
    if (position.kind === 'pinned' && (contentSizeChanged || viewportSizeChanged)) {
      scheduleCommit();
    }
    scheduleInitialEndReconciliation();
    const isScrolling = instance.isScrolling;
    const scrollingEnded = virtualizerWasScrolling && !isScrolling;
    virtualizerWasScrolling = isScrolling;
    if (scrollingEnded) historyController.onVirtualizerScrollSettled();
  }

  function holdAnchorThroughUpdate(): void {
    if (anchorHolding) return;
    anchor.capture();
    if (anchor.held === null) return;
    commitDeferred = false;
    const holdId = (anchorHoldSequence += 1);
    activeHoldId = holdId;
    anchorHolding = true;
    historyController.suspendForAnchor();
    void (async () => {
      const owns = (): boolean => activeHoldId === holdId;
      await tick();
      if (!owns()) {
        finishHold(holdId, 0);
        return;
      }
      await bringAnchorIntoView();
      if (!owns()) {
        finishHold(holdId, 0);
        return;
      }
      anchor.restore();
      const correctedAt = measurementRevision;
      await new Promise(requestAnimationFrame);
      if (!owns()) {
        finishHold(holdId, 0);
        return;
      }
      finishHold(holdId, measurementRevision === correctedAt ? 0 : anchor.restore());
    })();
  }

  async function bringAnchorIntoView(): Promise<void> {
    const view = anchorViewport();
    if (!view) return;
    const target = anchor.locate((key) =>
      visibleItems.findIndex((item) => anchorKeyForItem(item) === key)
    );
    if (!target || view.topOf(target.snapshot.key) !== null) return;
    const offset = offsetOfIndex(target.index + historyRowOffset, 'start');
    if (offset === null) return;
    scrollToOffsetNow(Math.max(0, offset - target.snapshot.top), 'bringAnchorIntoView');
    await new Promise(requestAnimationFrame);
  }

  function finishHold(holdId: number, residual: number | null): void {
    if (activeHoldId !== holdId) return;
    activeHoldId = null;
    anchorResidual = residual;
    anchor.release();
    anchorHolding = false;
    historyController.resumeAfterAnchor(residual);
    refreshRollingAnchor();
  }

  function refreshRollingAnchor(readingBack = false): void {
    if (anchorHolding || !viewport) return;
    if (!readingBack && isNearLatest(viewport, nearLatestPx)) {
      anchor.release();
      return;
    }
    anchor.capture();
  }

  function correctRollingAnchor(): void {
    if (anchorCorrecting || !anchorRolling()) return;
    anchorCorrecting = true;
    try {
      anchorResidual = anchor.restoreStationary();
    } finally {
      anchorCorrecting = false;
    }
  }

  let commitDeferred = false;
  let commitScheduled = false;

  function commit(): void {
    const node = currentViewport();
    if (!node || anchorHolding) return;
    if (position.kind === 'anchored' || position.kind === 'focused') return;
    // The gesture's scroll event has not landed, so the position it will produce
    // is unknown. Committing now would take the reader to the end.
    if (historyController.isScrollGestureActive) {
      commitDeferred = true;
      return;
    }
    scrollToOffsetNow(node.scrollHeight, 'commit');
    nearLatest = true;
    atLatest = true;
  }

  function unreadLandingKey(): string | null {
    const index = visibleItems.findIndex((item) => item.content.kind === 'read_marker');
    if (index === -1 || index >= visibleItems.length - 1) return null;
    return anchorKeyForItem(visibleItems[index]);
  }

  function landOn(key: string): void {
    const index = visibleItems.findIndex((item) => anchorKeyForItem(item) === key);
    if (index < 0) return;
    const offset = offsetOfIndex(index + historyRowOffset, 'start');
    if (offset === null) return;
    scrollToOffsetNow(offset, 'landOn');
    refreshRollingAnchor();
  }

  function scheduleCommit(): void {
    if (commitScheduled) return;
    commitScheduled = true;
    requestAnimationFrame(() => {
      commitScheduled = false;
      commit();
    });
  }

  function isSettling(): boolean {
    return position.kind === 'settling';
  }

  /**
   * The fill outlives the reveal: a room with nothing to land on is shown pinned
   * to the end and pads itself out behind the reader, whose rows the prepend's
   * own anchor hold keeps still. It stops once the reader takes over the offset.
   */
  function fillOwnsPosition(): boolean {
    return isSettling() || (revealedBeforeFill && position.kind === 'pinned');
  }

  function initialFillCancelled(): boolean {
    return currentViewport() === null || !fillOwnsPosition();
  }

  /**
   * `paginateBackward` resolves before the diff carrying its events, so the store
   * holds `loading` until the boundary moves. Bounded: a lost diff must not leave
   * the timeline hidden. False only when the fill was cancelled.
   */
  async function awaitPaginationSettled(
    cancelled: () => boolean = initialFillCancelled
  ): Promise<boolean> {
    const deadline = performance.now() + TIMELINE_LAYOUT.initialFillSettleTimeout;
    while (timeline.backwardPagination === 'loading') {
      if (performance.now() >= deadline) return true;
      await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.initialFillPollInterval));
      if (cancelled()) return false;
    }
    return true;
  }

  async function fillInitialHistory(): Promise<void> {
    while (initialFillPages < fillPageLimit()) {
      const node = currentViewport();
      if (node === null || !fillOwnsPosition()) return;
      // `end` is the server reporting the start of the timeline.
      if (timeline.backwardPagination === 'end') return;
      if (timeline.backwardPagination === 'loading') {
        if (initialFillPages > 0) return;
        initialFillPages += 1;
        if (!(await awaitPaginationSettled()) || initialFillCancelled()) return;
        continue;
      }
      // `scrollHeight` never reports less than the viewport, so it cannot tell a
      // half-full snapshot from an exactly-full one.
      const contentHeight = get(virtualizer).getTotalSize();
      if (contentHeight >= node.clientHeight * TIMELINE_LAYOUT.initialFillViewports) return;
      initialFillPages += 1;
      const reachedStart = await requestHistory();
      historyExhausted = reachedStart;
      // The last page has to settle too, or the handover finds `loading` and declines.
      if (!(await awaitPaginationSettled()) || initialFillCancelled()) return;
      await tick();
      await new Promise(requestAnimationFrame);
      if (initialFillCancelled()) return;
      commit();
      if (reachedStart) return;
    }
  }

  $effect(() => {
    if (visibleItems.length > 0) {
      hadVisibleItems = true;
      emptyRefillPages = 0;
      return;
    }
    if (hadVisibleItems) {
      hadVisibleItems = false;
      historyExhausted = false;
      emptyRefillPages = 0;
      initialFillPages = 0;
      openingBackfillGeneration += 1;
      openingBackfillState = 'idle';
    }
    if (
      timeline.loading ||
      viewport === null ||
      position.kind === 'settling' ||
      historyExhausted ||
      timeline.backwardPagination !== 'idle' ||
      initialFillState === 'running' ||
      emptyRefillPending ||
      initialFillPages + emptyRefillPages >= TIMELINE_LAYOUT.emptyFillMaxPages
    ) {
      return;
    }
    emptyRefillPages += 1;
    emptyRefillPending = true;
    void (async () => {
      try {
        const reachedStart = await requestHistory();
        historyExhausted = reachedStart && visibleItems.length > 0;
      } finally {
        emptyRefillPending = false;
      }
    })();
  });

  function fillPageLimit(): number {
    return visibleItems.length === 0
      ? TIMELINE_LAYOUT.emptyFillMaxPages
      : TIMELINE_LAYOUT.initialFillMaxPages;
  }

  function startInitialHistoryFill(): void {
    initialFillState = 'running';
    void fillInitialHistory().finally(() => {
      initialFillState = 'done';
      scheduleInitialEndReconciliation();
    });
  }

  function startOpeningBackfill(): void {
    if (openingBackfillState !== 'idle') return;
    const generation = (openingBackfillGeneration += 1);
    const cancelled = (): boolean =>
      generation !== openingBackfillGeneration || viewport === null || position.kind === 'settling';
    openingBackfillState = 'running';
    void (async () => {
      try {
        for (let page = 0; page < TIMELINE_LAYOUT.emptyFillMaxPages; page += 1) {
          const node = currentViewport();
          if (cancelled() || node === null) return;
          if (historyExhausted || timeline.backwardPagination === 'end') return;
          if (timeline.backwardPagination === 'loading') {
            if (!(await awaitPaginationSettled(cancelled))) return;
            page -= 1;
            continue;
          }
          const messageHeight = Math.max(
            0,
            get(virtualizer).getTotalSize() - historyPlaceholderHeight
          );
          if (messageHeight >= node.clientHeight) return;

          const reachedStart = await requestHistory();
          if (cancelled()) return;
          historyExhausted = reachedStart;
          if (!(await awaitPaginationSettled(cancelled))) return;
          await tick();
          await new Promise(requestAnimationFrame);
          if (reachedStart || cancelled()) return;
          await new Promise((resolve) =>
            setTimeout(resolve, TIMELINE_LAYOUT.historyRequestMinInterval)
          );
        }
      } finally {
        if (generation === openingBackfillGeneration) openingBackfillState = 'done';
      }
    })();
  }

  $effect(() => {
    const viewportHeight = virtualizerViewportSize || viewport?.clientHeight || 0;
    const messageHeight = Math.max(0, get(virtualizer).getTotalSize() - historyPlaceholderHeight);
    if (
      position.kind === 'settling' ||
      initialFillState !== 'done' ||
      viewportHeight <= 0 ||
      messageHeight >= viewportHeight ||
      visibleItems.length === 0 ||
      historyExhausted ||
      timeline.backwardPagination === 'end' ||
      openingBackfillState !== 'idle'
    ) {
      return;
    }
    startOpeningBackfill();
  });

  function scheduleInitialEndReconciliation(): void {
    if (position.kind !== 'settling' || initialEndReconciliationPending) return;
    // Handing over mid-fill reveals the timeline between pages. An empty timeline
    // never starts a fill, so it must not wait for one.
    if (initialFillState !== 'done' && visibleItems.length > 0) return;
    // It reschedules itself until the end settles, and runs while hidden, so an
    // unbounded list would spin for as long as the room stayed open.
    if (initialEndReconciliationAttempts >= INITIAL_END_RECONCILIATION_LIMIT) {
      const landed = nextPosition(position, {
        kind: 'fill-finished',
        unreadKey: unreadLandingKey(),
      });
      setPosition(landed);
      if (landed.kind === 'anchored') landOn(landed.key);
      else scheduleCommit();
      return;
    }
    initialEndReconciliationAttempts += 1;

    initialEndReconciliationPending = true;
    void tick().then(async () => {
      initialEndReconciliationPending = false;
      if (position.kind !== 'settling' || !viewport) return;

      commit();
      await new Promise(requestAnimationFrame);
      const activeViewport = currentViewport();
      // A frame has passed, so the position has to be read afresh. Through a
      // call, which the narrowing from the check above does not reach into.
      if (!isSettling() || !activeViewport) return;
      const distance =
        activeViewport.scrollHeight - activeViewport.scrollTop - activeViewport.clientHeight;
      if (distance > 1 || get(virtualizer).isScrolling) {
        scheduleInitialEndReconciliation();
        return;
      }
      // The fill already waited out its pages; one landing after the deadline is
      // a plain prepend, which the anchor hold covers.
      const landed = nextPosition(position, {
        kind: 'fill-finished',
        unreadKey: unreadLandingKey(),
      });
      setPosition(landed);
      if (landed.kind === 'anchored') landOn(landed.key);
      else scheduleCommit();
    });
  }

  $effect(() => {
    void preferences.fontScale;
    cachedRootFontSize = rootFontSize();
  });

  function renderRowKey(
    rows: readonly TimelineRenderRow[],
    items: readonly TimelineItemView[],
    index: number
  ): string {
    const row = rows[index];
    if (!row) return 'missing';
    return row.kind === 'history' ? HISTORY_ROW_KEY : identityTracker.key(items, row.itemIndex);
  }

  $effect.pre(() => {
    const items = visibleItems;
    const rows = renderRows;
    const instance = get(virtualizer);
    const previousItems = configuredItems;
    const previousRows = configuredRows;
    configuredItems = items;
    configuredRows = rows;
    identityTracker.reconcile(items);
    const itemEdgesChanged =
      previousItems.length !== items.length ||
      identityTracker.key(previousItems, 0) !== identityTracker.key(items, 0) ||
      identityTracker.key(previousItems, previousItems.length - 1) !==
        identityTracker.key(items, items.length - 1);
    const prepended = identityTracker.key(previousItems, 0) !== identityTracker.key(items, 0);
    const edgesChanged =
      itemEdgesChanged ||
      previousRows.length !== rows.length ||
      renderRowKey(previousRows, previousItems, 0) !== renderRowKey(rows, items, 0) ||
      renderRowKey(previousRows, previousItems, previousRows.length - 1) !==
        renderRowKey(rows, items, rows.length - 1);
    const rowPrepended =
      renderRowKey(previousRows, previousItems, 0) !== renderRowKey(rows, items, 0);
    historyController.resetForNewItems(prepended);
    const change = edgesChanged ? (historyDebugChange += 1) : historyDebugChange;
    if (edgesChanged) {
      historyDebugLog('items:before', {
        change,
        previousCount: previousItems.length,
        nextCount: items.length,
        previousFirstKey: identityTracker.key(previousItems, 0),
        nextFirstKey: identityTracker.key(items, 0),
        pagination: timeline.backwardPagination,
        viewport: historyDebugSnapshot(),
      });
    }
    const sent = hasNewLocalEcho(previousItems, items);
    if (sent && position.kind !== 'pinned') {
      setPosition(nextPosition(position, { kind: 'jump-to-latest' }));
      // The virtualiser does not report the append as a size change here, so the
      // offset cannot wait on `handleVirtualizerChange` to schedule it.
      scheduleCommit();
    }
    // `position` goes stale: a programmatic scroll raises no gesture and a
    // wheel at offset zero raises no scroll event.
    const pinnedToEnd = viewport !== null && isNearLatest(viewport, nearLatestPx);
    // Prepended history has to be held even at the end: a wheel in a room that
    // fits the viewport raises no scroll event, so the gesture stays pending and
    // the end-follow declines, stranding the newest message out of view.
    if (
      edgesChanged &&
      !sent &&
      (rowPrepended || !pinnedToEnd) &&
      position.kind !== 'settling' &&
      position.kind !== 'focused'
    ) {
      holdAnchorThroughUpdate();
    }
    const rem = cachedRootFontSize;
    nearLatestPx = TIMELINE_LAYOUT.jumpToLatestRem * rem;
    const layout = preferences.layout;
    instance.setOptions({
      count: rows.length,
      getScrollElement: () => viewport,
      estimateSize: (index) => {
        const row = rows[index];
        if (!row) return 0;
        return row.kind === 'history'
          ? historyPlaceholderTargetHeight
          : estimateTimelineItemSize(
              items,
              row.itemIndex,
              viewport?.clientWidth ?? TIMELINE_LAYOUT.mediaMaxRem * rem,
              rem,
              layout
            );
      },
      // TanStack compares the previous and next key functions during prepends.
      // Each function must retain the item ordering it was created for.
      getItemKey: (index) => renderRowKey(rows, items, index),
      anchorTo: 'start',
      followOnAppend: false,
      scrollEndThreshold: 0,
      useScrollendEvent: true,
      overscan: 8,
      onChange: handleVirtualizerChange,
    });
    if (edgesChanged) {
      void tick().then(() => {
        historyDebugLog('items:after-tick', {
          change,
          viewport: historyDebugSnapshot(),
        });
        requestAnimationFrame(() => {
          historyDebugLog('items:after-frame', {
            change,
            viewport: historyDebugSnapshot(),
          });
        });
      });
    }
  });

  $effect(() => {
    // Read up front, so the landing re-runs for every page the fill prepends.
    void visibleItems.length;
    if (timeline.loading || !viewport) return;

    const controller = new AbortController();
    void (async () => {
      await tick();
      await new Promise(requestAnimationFrame);
      // An empty snapshot is an empty room, not one still loading: `loading` is
      // false only once it has been applied. Bailing here left such a room
      // settling for as long as it stayed open.
      if (controller.signal.aborted) return;
      const focusedEventId = position.kind === 'focused' ? position.eventId : null;
      const focusIndex = focusedEventId
        ? visibleItems.findIndex((item) => item.event_id === focusedEventId)
        : -1;
      if (focusIndex >= 0 && !focusAnchored) {
        const offset = offsetOfIndex(focusIndex + historyRowOffset, 'center');
        if (offset !== null) scrollToOffsetNow(offset, 'focus');
        focusAnchored = true;
      } else if (position.kind === 'settling') {
        const initialAnchorCancelled = (): boolean =>
          controller.signal.aborted || position.kind !== 'settling';
        commit();
        await new Promise(requestAnimationFrame);
        if (initialAnchorCancelled()) return;
        if (currentViewport() === null) return;
        if (unreadLandingKey() === null && visibleItems.length > 0) {
          revealedBeforeFill = true;
          setPosition(nextPosition(position, { kind: 'fill-finished', unreadKey: null }));
        }
        // The fill re-enters the reconciliation once it is done.
        if (initialFillState === 'idle') {
          startInitialHistoryFill();
          return;
        }
        if (initialFillState === 'running') return;
        if (historyController.isRequestPending || timeline.backwardPagination === 'loading') return;
        scheduleInitialEndReconciliation();
      }
    })();
    return () => {
      controller.abort();
    };
  });

  function measure(node: HTMLDivElement): void {
    get(virtualizer).measureElement(node);
  }

  function historyDebugSnapshot(): object | null {
    return timelineDebugSnapshot(viewport, get(virtualizer), position.kind);
  }

  function historyDebugLog(event: string, details: object): void {
    if (!timelineDebugEnabledForView) return;
    console.log(`[timeline-history] ${event} ${JSON.stringify(details)}`);
  }

  let previousScrollTop = 0;
  function onScroll(): void {
    if (!viewport) return;
    const userDelta = viewport.scrollTop - (expectedSelfOffset ?? previousScrollTop);
    expectedSelfOffset = null;
    if (anchorHolding && Math.abs(userDelta) > ANCHOR_EPSILON) anchor.shift(-userDelta);
    nearLatest = isNearLatest(viewport, nearLatestPx);
    refreshAtLatest();
    const byReader = Math.abs(userDelta) > ANCHOR_EPSILON;
    const movedAway = !atLatest && viewport.scrollTop < previousScrollTop;
    previousScrollTop = viewport.scrollTop;
    refreshRollingAnchor(movedAway && byReader);
    const next = nextPosition(position, {
      kind: 'user-scrolled',
      timelineMode: timeline.mode.kind,
      nearLatest,
      movedAway,
      byReader,
      anchorKey: anchor.held?.key ?? null,
      anchorTop: anchor.held?.top ?? 0,
    });
    if (next !== position) setPosition(next);
    if (position.kind !== 'settling') historyController.observeScroll(movedAway, nearLatest);
    historyController.clearUserScrollPending();
    let newestVisibleIndex: number | undefined;
    for (const virtualItem of get(virtualizer).getVirtualItems()) {
      const row = renderRows[virtualItem.index];
      if (row?.kind === 'item') newestVisibleIndex = row.itemIndex;
    }
    if (
      position.kind === 'focused' &&
      timeline.forwardPagination === 'idle' &&
      newestVisibleIndex !== undefined &&
      newestVisibleIndex >= visibleItems.length - TIMELINE_LAYOUT.historyPrefetchItems
    ) {
      void onRequestFuture();
    }
  }
  function userScrollMarker(node: HTMLDivElement): () => void {
    return historyController.attach(node);
  }

  /**
   * A shrinking viewport leaves the offset where it was, so the newest event
   * slides out of view. Nothing else recovers it: a resize raises no scroll event,
   * so `position` never reaches `pinned`.
   */
  function keepPinnedThroughResize(node: HTMLDivElement): () => void {
    let previousHeight: number | null = null;
    const observer = new ResizeObserver(() => {
      const height = node.clientHeight;
      const shrank = previousHeight !== null && height < previousHeight;
      previousHeight = height;
      // Growing is handled by the browser's own clamp.
      if (shrank) scheduleCommit();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }

  function remeasureRenderedRows(): void {
    if (!viewport) return;
    const instance = get(virtualizer);
    for (const node of viewport.querySelectorAll<HTMLElement>('[data-index]')) {
      const index = Number(node.dataset.index);
      const height = node.offsetHeight;
      if (!Number.isInteger(index) || index < 0 || height <= 0) continue;
      instance.resizeItem(index, height);
    }
  }

  function refreshAfterVisibilityChange(): void {
    if (document.visibilityState !== 'visible' || position.kind === 'settling') return;
    requestAnimationFrame(() => {
      if (document.visibilityState !== 'visible' || !viewport || position.kind === 'settling')
        return;
      get(virtualizer).scrollRect = {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      };
      remeasureRenderedRows();
      refreshAtLatest();
      if (position.kind === 'pinned') scheduleCommit();
    });
  }

  function setPersonaOpen(open: boolean): void {
    personaOpen = open;
  }

  // `overflow: hidden` would drop the scrollbar and reflow the messages, so the
  // gestures are cancelled instead. Svelte makes `ontouchmove` passive, hence
  // the explicit listeners.
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

  function jumpToLatest(): void {
    historyController.finishHistoryFill();
    setPosition({ kind: 'pinned' });
    recordScroll('jumpToLatest', viewport?.scrollTop ?? -1);
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    nearLatest = true;
    atLatest = true;
  }
</script>

<svelte:window onvisibilitychange={refreshAfterVisibilityChange} />

<TimelineReadReceipt {timeline} visibleEventId={readEventId} {onRead} />
<MessageContextMenu />

{#if timeline.error}
  <Alert class="timeline-error" variant="critical" role="alert"
    >{$i18n.t('timeline.loadFailed')}</Alert
  >
{/if}

<div
  class={['timeline-content', `spacing-${preferences.messageSpacing}`]}
  style={TIMELINE_LAYOUT_STYLE}
>
  {#if timelineDebugEnabledForView && timelineDebugSample}
    <aside class="timeline-debug">
      <strong>Timeline debug</strong>
      <span>mode {timelineDebugSample.scrollMode}</span>
      <span>history {timelineDebugSample.backwardPagination}</span>
      <span>scroll {timelineDebugSample.scrollTop.toFixed(1)}</span>
      <span>end distance {timelineDebugSample.distanceFromEnd.toFixed(1)}</span>
      <span>frame time {timelineDebugSample.frameDuration.toFixed(1)}ms</span>
      <span>max frame time {timelineDebugSample.maxFrameDuration.toFixed(1)}ms</span>
      <span>frame delta {timelineDebugSample.frameDelta.toFixed(1)}</span>
      <span>max delta {timelineDebugSample.maxFrameDelta.toFixed(1)}</span>
      <span>visual delta {timelineDebugSample.visualDelta.toFixed(1)}</span>
      <span>max visual delta {timelineDebugSample.maxVisualDelta.toFixed(1)}</span>
      <span>anchor residual {timelineDebugSample.anchorResidual?.toFixed(1) ?? 'lost'}</span>
      <span>max anchor residual {timelineDebugSample.maxAnchorResidual.toFixed(1)}</span>
      <span>
        range {timelineDebugSample.firstVirtualIndex ??
          '-'}..{timelineDebugSample.lastVirtualIndex ?? '-'}
      </span>
      <span>scrolling {String(timelineDebugSample.isScrolling)}</span>
      <Button size="small" variant="ghost" onclick={copyTimelineDebug}>Copy trace</Button>
    </aside>
  {/if}
  {#if stuckUnreadCount > 0}
    <p class="unread-pinned">
      <span>{$i18n.t('timeline.unreadCount', { count: stuckUnreadCount })}</span>
    </p>
  {/if}

  <div class="timeline-stage">
    <div class={['timeline-viewport', { initial: position.kind === 'settling' }]}>
      <!-- A scrollable region has to be keyboard-operable. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        bind:this={viewport}
        class="viewport"
        aria-label={$i18n.t('timeline.label')}
        tabindex="0"
        onscroll={onScroll}
        {@attach userScrollMarker}
        {@attach keepPinnedThroughResize}
        {@attach scrollLock(scrollLocked || personaOpen)}
        role="log"
      >
        <div
          class={['items', `layout-${preferences.layout}`]}
          style:height={String($virtualizer.getTotalSize()) + 'px'}
        >
          {#each $virtualizer.getVirtualItems() as virtualItem (virtualItem.key)}
            {@const row = renderRows[virtualItem.index]}
            {#if row?.kind === 'history'}
              <div
                class="item history-placeholder-row"
                data-index={virtualItem.index}
                style:transform={'translateY(' + String(virtualItem.start) + 'px)'}
                {@attach measure}
              >
                <TimelineSkeleton
                  mode="history"
                  layout={preferences.layout}
                  targetHeight={historyPlaceholderTargetHeight}
                  onHeightChange={setHistoryPlaceholderHeight}
                />
              </div>
            {:else if row?.kind === 'item'}
              {@const item = row.item}
              {@const itemIndex = row.itemIndex}
              {@const collapsed = isCollapsed(visibleItems, itemIndex)}
              {@const groupStart = itemIndex > 0 && !collapsed}
              <div
                class={['item', { collapsed, 'group-start': groupStart }]}
                data-event-id={item.event_id ?? undefined}
                data-item-id={item.id}
                data-index={virtualItem.index}
                style:transform={'translateY(' + String(virtualItem.start) + 'px)'}
                {@attach measure}
              >
                <TimelineItem
                  {item}
                  {collapsed}
                  unreadCount={item.content.kind === 'read_marker'
                    ? unreadCountAfter(visibleItems, itemIndex)
                    : 0}
                  replyPersona={item.in_reply_to ? personas(item.in_reply_to.event_id) : null}
                  highlighted={focusEventId !== null && item.event_id === focusEventId}
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
                  {onOpenThread}
                  {onEdit}
                  {onDelete}
                  {canRedactOthers}
                  {members}
                  layout={preferences.layout}
                  {onJumpToEvent}
                  {onOpenMedia}
                  {onVotePoll}
                  {onEndPoll}
                  onPersonaOpenChange={setPersonaOpen}
                  {roomId}
                />
              </div>
            {/if}
          {/each}
        </div>
      </div>
    </div>

    {#if position.kind === 'settling' && !noHistory}
      <TimelineSkeleton layout={preferences.layout} />
    {:else if visibleItems.length === 0}
      <!-- A room can filter down to nothing; without this that is a blank void. -->
      <EmptyState
        class="timeline-empty"
        title={timeline.items.length > 0
          ? $i18n.t('timeline.allFiltered')
          : $i18n.t('timeline.noMessages')}
        description={timeline.items.length > 0 ? $i18n.t('timeline.allFilteredHint') : undefined}
      />
    {/if}
  </div>

  {#if timeline.mode.kind === 'live' && position.kind === 'anchored' && !atLatest && visibleItems.length > 0}
    <Button
      type="button"
      class="jump-to-latest"
      variant="primary"
      size="small"
      onclick={jumpToLatest}>{$i18n.t('timeline.jumpToLatest')}</Button
    >
  {/if}

  <div class="timeline-foot">
    <TypingIndicator label={typingLabel} />
    {#if footTrailing}
      <div class="foot-trailing">{@render footTrailing()}</div>
    {/if}
  </div>
</div>

<style>
  :global(.timeline-error) {
    flex: 0 0 auto;
    font-size: var(--font-size-small);
  }

  .timeline-content {
    --timeline-group-gap: var(--space-200);
    --timeline-row-gap: var(--space-250);
    --timeline-row-padding: var(--space-100);

    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  .timeline-content.spacing-compact {
    --timeline-row-gap: var(--space-100);
  }

  .timeline-content.spacing-roomy {
    --timeline-row-gap: var(--space-300);
  }

  /* Desktop chat leads tighter; the type size is the same as everywhere else. */
  @media (width >= 48rem) and (hover: hover) and (pointer: fine) {
    .timeline-content {
      --line-height-body: 1.47;
    }
  }

  /* The overlays measure against the message area alone: a skeleton row over the
     foot below sits lower than any message ever will. */
  .timeline-stage {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  .timeline-viewport {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  /* No fade back in: the skeleton is opaque and uncovers a laid-out viewport. */
  .timeline-viewport.initial {
    visibility: hidden;
  }

  .timeline-debug {
    background: color-mix(in srgb, var(--sable-bg-container) 92%, transparent);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: grid;
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    gap: var(--space-050);
    left: var(--space-200);
    padding: var(--space-200);
    pointer-events: auto;
    position: absolute;
    top: 0.5rem;
    z-index: 3;
  }

  :global(.timeline-debug button) {
    margin-top: var(--space-100);
  }

  .viewport {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
    overscroll-behavior: contain;
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
  }

  .viewport:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }

  .viewport::-webkit-scrollbar {
    height: 0.5rem;
    width: 0.5rem;
  }

  .viewport::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: var(--radius-pill);
  }

  .viewport::-webkit-scrollbar-track {
    background: transparent;
  }

  .viewport:hover,
  .viewport:focus-within {
    scrollbar-color: var(--sable-surface-container-line) transparent;
  }

  .viewport:hover::-webkit-scrollbar-thumb,
  .viewport:focus-within::-webkit-scrollbar-thumb {
    background: var(--sable-surface-container-line);
  }

  /* A history that fits the viewport would otherwise stack against the top. An
     auto margin collapses to zero once the rows overflow; `justify-content` would
     push the overflow past the unreachable start edge instead. */
  .items {
    flex: 0 0 auto;
    margin-top: auto;
    position: relative;
    width: 100%;
  }

  .item {
    box-sizing: border-box;
    left: 0;
    padding: var(--timeline-row-padding) var(--page-gutter);
    position: absolute;
    right: 0;
    top: 0;
    width: 100%;
  }

  .item.history-placeholder-row {
    padding: 0;
  }

  .item.collapsed {
    padding-top: 0;
  }

  .item.group-start {
    padding-top: calc(var(--timeline-row-padding) + var(--timeline-group-gap));
  }

  .unread-pinned {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    inset-inline: 0;
    margin: 0;
    padding: 0 var(--space-400);
    pointer-events: none;
    position: absolute;
    top: 0;
    z-index: 1;
  }

  .unread-pinned::before {
    border-top: calc(var(--border-width) * 2) solid var(--sable-primary-main-line);
    content: '';
    flex: 1;
  }

  .unread-pinned span {
    background: var(--sable-primary-container);
    border: var(--border-width) solid var(--sable-primary-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.04em;
    padding: var(--space-050) var(--space-200);
  }

  .timeline-foot {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-200);
    height: 1.5rem;
    justify-content: space-between;
    padding: 0 var(--page-gutter);
  }

  .foot-trailing {
    flex: none;
  }

  :global(button.jump-to-latest) {
    background-color: var(--sable-bg-container);
    background-image: linear-gradient(
      var(--sable-primary-container),
      var(--sable-primary-container)
    );
    bottom: var(--space-400);
    box-shadow: var(--shadow-float);
    left: 50%;
    position: absolute;
    transform: translateX(-50%);
    z-index: 1;
  }
</style>
