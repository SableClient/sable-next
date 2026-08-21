<script lang="ts">
  import { tick } from 'svelte';
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
    initialTimelineScrollMode,
    isNearLatest,
    type TimelineScrollMode,
  } from './timeline-scroll';
  import { nextScrollMode } from './timeline-scroll-policy';
  import FoldedEventRun from './FoldedEventRun.svelte';
  import {
    foldEventRuns,
    isCollapsed,
    personasByEventId,
    unreadCountAfter,
    visibleTimelineItems,
  } from './timeline-format';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';

  interface Props {
    timeline: RoomTimeline;
    focusEventId?: string | null;
    onRequestHistory: () => Promise<boolean>;
    onRequestFuture: () => Promise<void>;
    onRead: (eventId: string) => Promise<void>;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onCopyLink?: (eventId: string) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onRetrySend?: (transactionId: string) => void;
    onCancelSend?: (transactionId: string) => void;
    currentUserId?: string | null;
    onToggleReaction?: (eventId: string, key: string) => void;
    onReply?: (eventId: string) => void;
    onEdit?: (eventId: string, body: string) => void;
    onDelete?: (eventId: string, reason: string | null) => void;
    roomId?: string;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
    onOpenMedia?: (eventId: string) => void;
    readOnly?: boolean;
    canRedactOthers?: boolean;
    scrollLocked?: boolean;
    nearLatest?: boolean;
    followingLive?: boolean;
  }

  let {
    timeline,
    focusEventId = null,
    onRequestHistory,
    onRequestFuture,
    onRead,
    onMatrixLink,
    onCopyLink,
    onSenderProfile,
    onRetrySend,
    onCancelSend,
    currentUserId,
    onToggleReaction,
    onReply,
    onEdit,
    onDelete,
    roomId,
    members = [],
    onJumpToEvent,
    onOpenMedia,
    readOnly = false,
    canRedactOthers = false,
    scrollLocked = false,
    nearLatest = $bindable(true),
    followingLive = $bindable(false),
  }: Props = $props();
  let folded = $derived(
    foldEventRuns(visibleTimelineItems(timeline.items, preferences, { readOnly }))
  );
  let visibleItems = $derived(folded.items);
  let personas = $derived(personasByEventId(timeline.items));
  let personaOpen = $state(false);

  // Virtual rows are absolutely positioned, so the separator cannot be sticky
  // in flow; it is mirrored above once its own row has scrolled past the top.
  let stuckUnreadCount = $derived.by(() => {
    const index = visibleItems.findIndex((item) => item.content.kind === 'read_marker');
    if (index === -1) return 0;
    const top = $virtualizer.getVirtualItemForOffset($virtualizer.scrollOffset ?? 0);
    if (top === undefined || index >= top.index) return 0;
    return unreadCountAfter(visibleItems, index);
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
    smoothTarget = target;
    setScrollMode({ kind: 'focused', eventId: target });
    focusAnchored = true;
    get(virtualizer).scrollToIndex(index, { align: 'center', behavior: 'smooth' });
  });
  let viewport = $state<HTMLDivElement | null>(null);
  let initialFillState: 'idle' | 'running' | 'done' = 'idle';
  let initialFillPages = 0;
  let virtualizerWasScrolling = false;
  let virtualizerTotalSize = 0;
  let virtualizerViewportSize = 0;
  let focusAnchored = false;
  // Only the mount-time target picks the mode; later ones go through the effect.
  // svelte-ignore state_referenced_locally
  let scrollMode = $state<TimelineScrollMode>(initialTimelineScrollMode(focusEventId));
  function setScrollMode(mode: TimelineScrollMode): void {
    scrollMode = mode;
    followingLive = mode.kind === 'followingLive';
  }
  const initialItems: readonly TimelineItemView[] = [];
  const INITIAL_END_RECONCILIATION_LIMIT = 60;
  let initialEndReconciliationAttempts = 0;
  let initialEndReconciliationPending = false;
  let followingEndReconciliationPending = false;
  let timelineDebugSample = $state<TimelineDebugSample | null>(null);
  const timelineDebugRecorder = new TimelineDebugRecorder();
  const identityTracker = new TimelineIdentityTracker();
  const timelineDebugEnabledForView = timelineDebugEnabled();
  let historyController: TimelineHistoryController;
  let configuredItems: readonly TimelineItemView[] = initialItems;
  let historyDebugChange = 0;

  let anchorHolding = false;
  let anchorRolling = false;
  let anchorCorrecting = false;
  let anchorHoldSequence = 0;
  let activeHoldId: number | null = null;
  let measurementRevision = 0;
  let anchorCorrection: { by: string; delta: number; key: string | null } | null = null;
  let anchorAbandoned = false;
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

  // The virtualiser's helpers arm `reconcileScroll`, which forces the offset back
  // to its own target for five seconds.
  function scrollToOffsetNow(offset: number): void {
    if (!viewport) return;
    viewport.scrollTop = offset;
    recordSelfWrite();
  }

  function scrollToEndNow(): void {
    if (!viewport) return;
    scrollToOffsetNow(viewport.scrollHeight);
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
    anchorTo: 'end',
    // Arms `reconcileScroll`, which forces the virtualiser's own target back for
    // five seconds, recomputed against the live viewport. End-following belongs
    // to `scheduleFollowingEndReconciliation`.
    followOnAppend: false,
    scrollEndThreshold: nearLatestPx,
    useScrollendEvent: true,
    overscan: 24,
    onChange: handleVirtualizerChange,
  });

  get(virtualizer).shouldAdjustScrollPositionOnItemSizeChange = () => false;

  historyController = new TimelineHistoryController({
    getBackwardPagination: () => timeline.backwardPagination,
    isNearOldest: () => viewport !== null && viewport.scrollTop < viewport.clientHeight * 2,
    isVirtualizerScrolling: () => get(virtualizer).isScrolling,
    requestHistory: () => onRequestHistory(),
    onGestureSettled: () => {
      if (!endFollowDeferred) return;
      endFollowDeferred = false;
      scheduleFollowingEndReconciliation(true);
    },
    debugLog: historyDebugLog,
    debugSnapshot: () => timelineDebugSnapshot(viewport, get(virtualizer), scrollMode.kind),
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
          anchorGuard: anchorHolding ? 'hold' : anchorRolling ? 'rolling' : 'none',
          anchorCorrection,
          firstVirtualIndex: virtualItems[0]?.index ?? null,
          lastVirtualIndex: virtualItems.at(-1)?.index ?? null,
          isScrolling: instance.isScrolling,
          scrollMode: scrollMode.kind,
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
    if (contentSizeChanged) measurementRevision += 1;
    if (contentSizeChanged) correctRollingAnchor();
    if (scrollMode.kind === 'followingLive' && (contentSizeChanged || viewportSizeChanged)) {
      scheduleFollowingEndReconciliation();
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
    endFollowDeferred = false;
    const holdId = (anchorHoldSequence += 1);
    activeHoldId = holdId;
    anchorHolding = true;
    anchorRolling = false;
    anchorAbandoned = false;
    historyController.suspendForAnchor();
    void (async () => {
      const owns = (): boolean => activeHoldId === holdId && !anchorAbandoned;
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
    const offset = get(virtualizer).getOffsetForIndex(target.index, 'start')?.[0];
    if (offset === undefined) return;
    scrollToOffsetNow(Math.max(0, offset - target.snapshot.top));
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

  function refreshRollingAnchor(): void {
    if (anchorHolding || !viewport) return;
    if (isNearLatest(viewport, nearLatestPx)) {
      anchorRolling = false;
      anchor.release();
      return;
    }
    anchorRolling = true;
    anchor.capture();
  }

  function correctRollingAnchor(): void {
    if (anchorHolding || anchorCorrecting || !anchorRolling) return;
    anchorCorrecting = true;
    try {
      anchorResidual = anchor.restoreStationary();
    } finally {
      anchorCorrecting = false;
    }
  }

  function releaseAnchor(): void {
    if (!anchorHolding) return;
    anchorAbandoned = true;
    anchor.release();
  }

  let endFollowDeferred = false;

  function scheduleFollowingEndReconciliation(afterGesture = false): void {
    if (followingEndReconciliationPending) return;

    followingEndReconciliationPending = true;
    void tick().then(() => {
      followingEndReconciliationPending = false;
      if (scrollMode.kind !== 'followingLive' || !viewport) return;
      if (!afterGesture && historyController.isScrollGestureActive) {
        endFollowDeferred = true;
        return;
      }
      scrollToEndNow();
      nearLatest = true;
    });
  }

  function isInitialLive(): boolean {
    return scrollMode.kind === 'initialLive';
  }

  function initialFillCancelled(): boolean {
    return currentViewport() === null || !isInitialLive();
  }

  /**
   * `paginateBackward` resolves before the diff carrying its events, so the store
   * holds `loading` until the boundary moves. Bounded: a lost diff must not leave
   * the timeline hidden. False only when the fill was cancelled.
   */
  async function awaitPaginationSettled(): Promise<boolean> {
    const deadline = performance.now() + TIMELINE_LAYOUT.initialFillSettleTimeout;
    while (timeline.backwardPagination === 'loading') {
      if (performance.now() >= deadline) return true;
      await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.initialFillPollInterval));
      if (initialFillCancelled()) return false;
    }
    return true;
  }

  /** Pads out a snapshot too short to fill the viewport, while it is still hidden. */
  async function fillInitialHistory(): Promise<void> {
    while (initialFillPages < TIMELINE_LAYOUT.initialFillMaxPages) {
      const node = currentViewport();
      if (node === null || !isInitialLive()) return;
      // `end` is the server reporting the start of the timeline.
      if (timeline.backwardPagination !== 'idle') return;
      // `scrollHeight` never reports less than the viewport, so it cannot tell a
      // half-full snapshot from an exactly-full one.
      const contentHeight = get(virtualizer).getTotalSize();
      if (contentHeight >= node.clientHeight * TIMELINE_LAYOUT.initialFillViewports) return;
      initialFillPages += 1;
      const reachedStart = await onRequestHistory();
      // The last page has to settle too, or the handover finds `loading` and declines.
      if (!(await awaitPaginationSettled()) || initialFillCancelled()) return;
      await tick();
      await new Promise(requestAnimationFrame);
      if (initialFillCancelled()) return;
      scrollToEndNow();
      if (reachedStart) return;
    }
  }

  function startInitialHistoryFill(): void {
    initialFillState = 'running';
    void fillInitialHistory().finally(() => {
      initialFillState = 'done';
      scheduleInitialEndReconciliation();
    });
  }

  function scheduleInitialEndReconciliation(): void {
    if (scrollMode.kind !== 'initialLive' || initialEndReconciliationPending) return;
    // Handing over mid-fill reveals the timeline between pages. An empty timeline
    // never starts a fill, so it must not wait for one.
    if (initialFillState !== 'done' && visibleItems.length > 0) return;
    // It reschedules itself until the end settles, and runs while hidden, so an
    // unbounded list would spin for as long as the room stayed open.
    if (initialEndReconciliationAttempts >= INITIAL_END_RECONCILIATION_LIMIT) {
      setScrollMode({ kind: 'followingLive' });
      return;
    }
    initialEndReconciliationAttempts += 1;

    initialEndReconciliationPending = true;
    void tick().then(async () => {
      initialEndReconciliationPending = false;
      if (scrollMode.kind !== 'initialLive' || !viewport) return;

      scrollToEndNow();
      await new Promise(requestAnimationFrame);
      const activeViewport = currentViewport();
      // A frame has passed, so the mode has to be read afresh. Through a call,
      // which the narrowing from the check above does not reach into.
      if (!isInitialLive() || !activeViewport) return;
      const distance =
        activeViewport.scrollHeight - activeViewport.scrollTop - activeViewport.clientHeight;
      if (distance > 1 || get(virtualizer).isScrolling) {
        scheduleInitialEndReconciliation();
        return;
      }
      // The fill already waited out its pages; one landing after the deadline is
      // a plain prepend, which the anchor hold covers.
      nearLatest = true;
      setScrollMode({ kind: 'followingLive' });
      scheduleFollowingEndReconciliation();
    });
  }

  $effect.pre(() => {
    const items = visibleItems;
    const instance = get(virtualizer);
    const previousItems = configuredItems;
    configuredItems = items;
    identityTracker.reconcile(items);
    const edgesChanged =
      previousItems.length !== items.length ||
      identityTracker.key(previousItems, 0) !== identityTracker.key(items, 0) ||
      identityTracker.key(previousItems, previousItems.length - 1) !==
        identityTracker.key(items, items.length - 1);
    const prepended = identityTracker.key(previousItems, 0) !== identityTracker.key(items, 0);
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
    // `scrollMode` goes stale: a programmatic scroll raises no gesture and a
    // wheel at offset zero raises no scroll event.
    const pinnedToEnd = viewport !== null && isNearLatest(viewport, nearLatestPx);
    // Prepended history has to be held even at the end: a wheel in a room that
    // fits the viewport raises no scroll event, so the gesture stays pending and
    // the end-follow declines, stranding the newest message out of view.
    if (
      edgesChanged &&
      (prepended || !pinnedToEnd) &&
      scrollMode.kind !== 'initialLive' &&
      scrollMode.kind !== 'focused'
    ) {
      holdAnchorThroughUpdate();
    }
    // `getComputedStyle` flushes style and the estimator runs per row.
    const rem = rootFontSize();
    nearLatestPx = TIMELINE_LAYOUT.jumpToLatestRem * rem;
    const layout = preferences.layout;
    instance.setOptions({
      count: items.length,
      getScrollElement: () => viewport,
      estimateSize: (index) =>
        estimateTimelineItemSize(
          items,
          index,
          viewport?.clientWidth ?? TIMELINE_LAYOUT.mediaMaxRem * rem,
          rem,
          layout
        ),
      // TanStack compares the previous and next key functions during prepends.
      // Each function must retain the item ordering it was created for.
      getItemKey: (index) => identityTracker.key(items, index),
      anchorTo: 'end',
      followOnAppend: false,
      scrollEndThreshold: nearLatestPx,
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
    // Read up front so the landing re-runs for every page the fill prepends.
    const hasItems = visibleItems.length > 0;
    if (timeline.loading || !viewport) return;

    const controller = new AbortController();
    void (async () => {
      await tick();
      await new Promise(requestAnimationFrame);
      if (controller.signal.aborted || !hasItems) return;
      const focusedEventId = scrollMode.kind === 'focused' ? scrollMode.eventId : null;
      const focusIndex = focusedEventId
        ? visibleItems.findIndex((item) => item.event_id === focusedEventId)
        : -1;
      if (focusIndex >= 0 && !focusAnchored) {
        get(virtualizer).scrollToIndex(focusIndex, { align: 'center' });
        focusAnchored = true;
      } else if (scrollMode.kind === 'initialLive') {
        const initialAnchorCancelled = (): boolean =>
          controller.signal.aborted || scrollMode.kind !== 'initialLive';
        scrollToEndNow();
        await new Promise(requestAnimationFrame);
        if (initialAnchorCancelled()) return;
        if (currentViewport() === null) return;
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
    return timelineDebugSnapshot(viewport, get(virtualizer), scrollMode.kind);
  }

  function historyDebugLog(event: string, details: object): void {
    if (!timelineDebugEnabledForView) return;
    console.log(`[timeline-history] ${event} ${JSON.stringify(details)}`);
  }

  function onScroll(): void {
    if (!viewport) return;
    const wasSelfScroll =
      expectedSelfOffset !== null &&
      Math.abs(viewport.scrollTop - expectedSelfOffset) <= ANCHOR_EPSILON;
    expectedSelfOffset = null;
    // Holding an anchor against the user is worse than losing it.
    if (!wasSelfScroll && historyController.hasUserScrollPending) releaseAnchor();
    nearLatest = isNearLatest(viewport, nearLatestPx);
    const next = nextScrollMode(scrollMode, {
      timelineMode: timeline.mode.kind,
      nearLatest,
      userDroveLastScroll: historyController.hasUserScrollPending,
      // The landing hands over on its own.
      initialLandingComplete: false,
      focusTarget: null,
    });
    if (next !== scrollMode) setScrollMode(next);
    refreshRollingAnchor();
    historyController.refreshQueuedRequest();
    historyController.clearUserScrollPending();
    const newestVisibleIndex = get(virtualizer).getVirtualItems().at(-1)?.index;
    if (
      scrollMode.kind === 'focused' &&
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
   * so `scrollMode` never reaches `followingLive`.
   */
  function keepPinnedThroughResize(node: HTMLDivElement): () => void {
    let previousHeight: number | null = null;
    const observer = new ResizeObserver(() => {
      const height = node.clientHeight;
      const shrank = previousHeight !== null && height < previousHeight;
      previousHeight = height;
      // Growing is handled by the browser's own clamp.
      if (!shrank) return;
      // The fill, a permalink landing and an anchor hold each own the offset.
      if (
        !nearLatest ||
        scrollMode.kind === 'initialLive' ||
        scrollMode.kind === 'focused' ||
        anchorHolding
      ) {
        return;
      }
      scrollToEndNow();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
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
    setScrollMode({ kind: 'followingLive' });
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    nearLatest = true;
  }
</script>

<TimelineReadReceipt {timeline} {followingLive} {nearLatest} {onRead} />

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

  <div class={['timeline-viewport', { initial: scrollMode.kind === 'initialLive' }]}>
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
          {@const item = visibleItems[virtualItem.index]}
          {#if item}
            {@const run = folded.runs.get(item.id)}
            {@const collapsed = isCollapsed(visibleItems, virtualItem.index)}
            {@const groupStart = virtualItem.index > 0 && !collapsed}
            <div
              class={['item', { collapsed, 'group-start': groupStart }]}
              data-event-id={item.event_id ?? undefined}
              data-item-id={item.id}
              data-index={virtualItem.index}
              style:transform={'translateY(' + String(virtualItem.start) + 'px)'}
              {@attach measure}
            >
              {#if run}
                <FoldedEventRun {run} />
              {:else}
                <TimelineItem
                  {item}
                  {collapsed}
                  unreadCount={item.content.kind === 'read_marker'
                    ? unreadCountAfter(visibleItems, virtualItem.index)
                    : 0}
                  replyPersona={item.in_reply_to
                    ? (personas.get(item.in_reply_to.event_id) ?? null)
                    : null}
                  highlighted={focusEventId !== null && item.event_id === focusEventId}
                  {onMatrixLink}
                  {onCopyLink}
                  {onSenderProfile}
                  {onRetrySend}
                  {onCancelSend}
                  {currentUserId}
                  {onToggleReaction}
                  {onReply}
                  {onEdit}
                  {onDelete}
                  {canRedactOthers}
                  {members}
                  layout={preferences.layout}
                  {onJumpToEvent}
                  {onOpenMedia}
                  onPersonaOpenChange={setPersonaOpen}
                  {roomId}
                />
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    </div>
  </div>

  {#if scrollMode.kind === 'initialLive'}<TimelineSkeleton />{/if}

  {#if timeline.mode.kind === 'live' && scrollMode.kind === 'readingHistory' && visibleItems.length > 0}
    <Button
      type="button"
      class="jump-to-latest"
      variant="primary"
      size="small"
      onclick={jumpToLatest}>{$i18n.t('timeline.jumpToLatest')}</Button
    >
  {/if}
</div>

<style>
  :global(.timeline-error) {
    flex: 0 0 auto;
    font-size: var(--font-size-small);
  }

  .timeline-content {
    --timeline-group-gap: var(--space-1);
    --timeline-row-gap: var(--space-relaxed-tight);
    --timeline-row-padding: var(--space-compact);

    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  .timeline-content.spacing-compact {
    --timeline-row-gap: var(--space-compact);
  }

  .timeline-content.spacing-roomy {
    --timeline-row-gap: var(--space-2);
  }

  /* Chat can be denser on desktop without reducing mobile reading size. */
  @media (width >= 48rem) and (hover: hover) and (pointer: fine) {
    .timeline-content {
      --line-height-body: 1.47;

      font-size: 0.9375rem;
    }
  }

  .timeline-viewport {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    opacity: 1;
    transition: opacity var(--motion-normal) var(--motion-easing-standard);
  }

  .timeline-viewport.initial {
    opacity: 0;
    visibility: hidden;
  }

  .timeline-debug {
    background: color-mix(in srgb, var(--sable-bg-container) 92%, transparent);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: grid;
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    gap: calc(var(--space-compact) / 2);
    left: var(--space-1);
    padding: var(--space-1);
    pointer-events: auto;
    position: absolute;
    top: 0.5rem;
    z-index: 3;
  }

  :global(.timeline-debug button) {
    margin-top: var(--space-compact);
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

  @media (prefers-reduced-motion: reduce) {
    .timeline-viewport {
      transition: none;
    }
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

  .item.collapsed {
    padding-top: 0;
  }

  .item.group-start {
    padding-top: calc(var(--timeline-row-padding) + var(--timeline-group-gap));
  }

  .unread-pinned {
    align-items: center;
    display: flex;
    gap: 0.5rem;
    inset-inline: 0;
    margin: 0;
    padding: 0 var(--space-3);
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
    padding: 0.125rem 0.5rem;
  }

  :global(.jump-to-latest) {
    bottom: 1rem;
    box-shadow: var(--shadow-float);
    left: 50%;
    position: absolute;
    transform: translateX(-50%);
    z-index: 1;
  }
</style>
