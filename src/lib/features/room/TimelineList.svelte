<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { createVirtualizer } from '@tanstack/svelte-virtual';

  import type { TimelineItemView } from '@/generated/TimelineItemView';
  import { i18n } from '$lib/i18n';
  import type { RoomTimeline } from '$lib/rooms/timeline.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';

  import TimelineItem from './TimelineItem.svelte';
  import type { MatrixLink } from './matrix-link';
  import TimelineSkeleton from './TimelineSkeleton.svelte';
  import { TimelineHistoryController } from './timeline-history';
  import { TimelineIdentityTracker } from './timeline-identity';
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
  import { isCollapsed, visibleTimelineItems } from './timeline-format';
  import { timelinePreferences } from '$lib/settings/timeline-preferences.svelte';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';

  interface Props {
    timeline: RoomTimeline;
    focusEventId?: string | null;
    onRequestHistory: () => Promise<boolean>;
    onRequestFuture: () => Promise<void>;
    onRead: (eventId: string) => Promise<void>;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onRetrySend?: (transactionId: string) => void;
    onCancelSend?: (transactionId: string) => void;
    currentUserId?: string | null;
    onToggleReaction?: (eventId: string, key: string) => void;
    onReply?: (eventId: string) => void;
    onEdit?: (eventId: string, body: string) => void;
    onDelete?: (eventId: string) => void;
    roomId?: string;
    scrollLocked?: boolean;
    nearLatest?: boolean;
  }

  let {
    timeline,
    focusEventId = null,
    onRequestHistory,
    onRequestFuture,
    onRead,
    onMatrixLink,
    onSenderProfile,
    onRetrySend,
    onCancelSend,
    currentUserId,
    onToggleReaction,
    onReply,
    onEdit,
    onDelete,
    roomId,
    scrollLocked = false,
    nearLatest = $bindable(true),
  }: Props = $props();
  let visibleItems = $derived(visibleTimelineItems(timeline.items, timelinePreferences));
  let viewport = $state<HTMLDivElement | null>(null);
  let initialHistoryRequested = $state(false);
  let virtualizerWasScrolling = false;
  let virtualizerTotalSize = 0;
  let virtualizerViewportSize = 0;
  let focusAnchored = false;
  let scrollMode = $state<TimelineScrollMode>(
    untrack(() => initialTimelineScrollMode(focusEventId))
  );
  const initialItems: readonly TimelineItemView[] = [];
  let initialEndReconciliationPending = false;
  let followingEndReconciliationPending = false;
  let timelineDebugSample = $state<TimelineDebugSample | null>(null);
  const timelineDebugRecorder = new TimelineDebugRecorder();
  const identityTracker = new TimelineIdentityTracker();
  const scrollRegionAttributes = { tabindex: 0 } as const;
  const timelineDebugEnabledForView = timelineDebugEnabled();
  let historyController: TimelineHistoryController;
  let historyDebugItems: readonly TimelineItemView[] = initialItems;
  let historyDebugChange = 0;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    estimateSize: (index) =>
      estimateTimelineItemSize(initialItems, index, TIMELINE_LAYOUT.mediaMaxRem * 16, 16),
    getItemKey: (index) => identityTracker.key(initialItems, index),
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: TIMELINE_LAYOUT.jumpToLatestThreshold,
    useScrollendEvent: true,
    overscan: 8,
    onChange: handleVirtualizerChange,
  });

  historyController = new TimelineHistoryController({
    getBackwardPagination: () => timeline.backwardPagination,
    isNearOldest: () => {
      if (!viewport) return false;
      const oldestVisibleIndex = get(virtualizer).getVirtualItemForOffset(
        viewport.scrollTop
      )?.index;
      return oldestVisibleIndex === undefined
        ? viewport.scrollTop === 0
        : oldestVisibleIndex < TIMELINE_LAYOUT.historyPrefetchItems;
    },
    isVirtualizerScrolling: () => get(virtualizer).isScrolling,
    requestHistory: () => onRequestHistory(),
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
        const visualDelta =
          anchorKey !== null && anchorKey === previousAnchorKey && previousAnchorTop !== null
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
    if (scrollMode.kind === 'followingLive' && (contentSizeChanged || viewportSizeChanged)) {
      scheduleFollowingEndReconciliation();
    }
    scheduleInitialEndReconciliation();
    const isScrolling = instance.isScrolling;
    const scrollingEnded = virtualizerWasScrolling && !isScrolling;
    virtualizerWasScrolling = isScrolling;
    if (scrollingEnded) historyController.onVirtualizerScrollSettled();
  }

  function scheduleFollowingEndReconciliation(): void {
    if (followingEndReconciliationPending) return;

    followingEndReconciliationPending = true;
    void tick().then(() => {
      followingEndReconciliationPending = false;
      if (
        scrollMode.kind !== 'followingLive' ||
        historyController.hasUserScrollPending ||
        !viewport
      )
        return;
      get(virtualizer).scrollToEnd({ behavior: 'auto' });
      nearLatest = true;
    });
  }

  function scheduleInitialEndReconciliation(): void {
    if (scrollMode.kind !== 'initialLive' || initialEndReconciliationPending) return;

    initialEndReconciliationPending = true;
    void tick().then(async () => {
      initialEndReconciliationPending = false;
      if (scrollMode.kind !== 'initialLive' || !viewport) return;

      get(virtualizer).scrollToEnd({ behavior: 'auto' });
      await new Promise(requestAnimationFrame);
      const activeViewport = viewport;
      if (untrack(() => scrollMode.kind) !== 'initialLive') return;
      const distance =
        activeViewport.scrollHeight - activeViewport.scrollTop - activeViewport.clientHeight;
      if (distance > 1 || get(virtualizer).isScrolling) {
        scheduleInitialEndReconciliation();
        return;
      }
      if (!historyController.isRequestPending && timeline.backwardPagination !== 'loading') {
        nearLatest = true;
        scrollMode = { kind: 'followingLive' };
        scheduleFollowingEndReconciliation();
      }
    });
  }

  $effect.pre(() => {
    const items = visibleItems;
    const instance = get(virtualizer);
    const previousItems = historyDebugItems;
    historyDebugItems = items;
    identityTracker.reconcile(items);
    const edgesChanged =
      previousItems.length !== items.length ||
      identityTracker.key(previousItems, 0) !== identityTracker.key(items, 0) ||
      identityTracker.key(previousItems, previousItems.length - 1) !==
        identityTracker.key(items, items.length - 1);
    historyController.resetForNewItems(
      identityTracker.key(previousItems, 0) !== identityTracker.key(items, 0)
    );
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
    // `getComputedStyle` flushes style and the estimator runs per row.
    const rem = rootFontSize();
    instance.setOptions({
      count: items.length,
      getScrollElement: () => viewport,
      estimateSize: (index) =>
        estimateTimelineItemSize(
          items,
          index,
          viewport?.clientWidth ?? TIMELINE_LAYOUT.mediaMaxRem * rem,
          rem
        ),
      // TanStack compares the previous and next key functions during prepends.
      // Each function must retain the item ordering it was created for.
      getItemKey: (index) => identityTracker.key(items, index),
      anchorTo: 'end',
      followOnAppend: true,
      scrollEndThreshold: TIMELINE_LAYOUT.jumpToLatestThreshold,
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
    if (timeline.loading || visibleItems.length === 0 || !viewport) return;

    const controller = new AbortController();
    void (async () => {
      await tick();
      await new Promise(requestAnimationFrame);
      if (controller.signal.aborted) return;
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
        get(virtualizer).scrollToEnd({ behavior: 'auto' });
        await new Promise(requestAnimationFrame);
        if (initialAnchorCancelled()) return;
        const needsMoreHistory = viewport.scrollHeight <= viewport.clientHeight + 1;
        if (
          !initialHistoryRequested &&
          needsMoreHistory &&
          timeline.backwardPagination === 'idle'
        ) {
          initialHistoryRequested = true;
          historyController.beginHistoryFill();
          historyController.requestHistoryNow();
          return;
        }
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
    nearLatest = isNearLatest(viewport, TIMELINE_LAYOUT.jumpToLatestThreshold);
    if (timeline.mode.kind === 'live' && scrollMode.kind !== 'initialLive') {
      if (nearLatest && scrollMode.kind !== 'followingLive') {
        scrollMode = { kind: 'followingLive' };
      } else if (
        !nearLatest &&
        scrollMode.kind !== 'readingHistory' &&
        historyController.hasUserScrollPending
      ) {
        scrollMode = { kind: 'readingHistory' };
      }
    }
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

  // `overflow: hidden` would drop the scrollbar and reflow the messages, so the
  // gestures are cancelled instead. Svelte makes `ontouchmove` passive, hence
  // the explicit listeners.
  function scrollLock(locked: boolean) {
    return (node: HTMLElement) => {
      if (!locked) return;
      const block = (event: Event): void => {
        event.preventDefault();
      };
      node.addEventListener('wheel', block, { passive: false });
      node.addEventListener('touchmove', block, { passive: false });
      return () => {
        node.removeEventListener('wheel', block);
        node.removeEventListener('touchmove', block);
      };
    };
  }

  function jumpToLatest(): void {
    historyController.finishHistoryFill();
    scrollMode = { kind: 'followingLive' };
    get(virtualizer).scrollToEnd({ behavior: 'smooth' });
    nearLatest = true;
  }
</script>

<TimelineReadReceipt
  {timeline}
  {focusEventId}
  initialAnchorComplete={scrollMode.kind === 'followingLive'}
  {nearLatest}
  {onRead}
/>

{#if timeline.error}
  <Alert class="timeline-error" variant="critical" role="alert"
    >{$i18n.t('timeline.loadFailed')}</Alert
  >
{/if}

<div class="timeline-content" style={TIMELINE_LAYOUT_STYLE}>
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
      <span>
        range {timelineDebugSample.firstVirtualIndex ??
          '-'}..{timelineDebugSample.lastVirtualIndex ?? '-'}
      </span>
      <span>scrolling {String(timelineDebugSample.isScrolling)}</span>
      <button type="button" onclick={copyTimelineDebug}>Copy trace</button>
    </aside>
  {/if}
  <div class={['timeline-viewport', { initial: scrollMode.kind === 'initialLive' }]}>
    <div
      bind:this={viewport}
      class="viewport"
      aria-label={$i18n.t('timeline.label')}
      {...scrollRegionAttributes}
      onscroll={onScroll}
      {@attach userScrollMarker}
      {@attach scrollLock(scrollLocked)}
      role="log"
    >
      <div class="items" style:height={String($virtualizer.getTotalSize()) + 'px'}>
        {#each $virtualizer.getVirtualItems() as virtualItem (virtualItem.key)}
          {@const item = visibleItems[virtualItem.index]}
          {#if item}
            <div
              class="item"
              data-event-id={item.event_id ?? undefined}
              data-item-id={item.id}
              data-index={virtualItem.index}
              style:transform={'translateY(' + String(virtualItem.start) + 'px)'}
              {@attach measure}
            >
              <TimelineItem
                {item}
                collapsed={isCollapsed(visibleItems, virtualItem.index)}
                highlighted={focusEventId !== null && item.event_id === focusEventId}
                {onMatrixLink}
                {onSenderProfile}
                {onRetrySend}
                {onCancelSend}
                {currentUserId}
                {onToggleReaction}
                {onReply}
                {onEdit}
                {onDelete}
                {roomId}
              />
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
    --timeline-row-gap: var(--space-relaxed-tight);
    --timeline-row-padding: var(--space-compact);

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
    opacity: 1;
    transition: opacity var(--motion-normal) var(--motion-easing-standard);
  }

  .timeline-viewport.initial {
    opacity: 0;
    visibility: hidden;
  }

  .timeline-debug {
    background: color-mix(in srgb, var(--sable-bg-container) 92%, transparent);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: grid;
    font-family: monospace;
    font-size: var(--font-size-small);
    gap: calc(var(--space-compact) / 2);
    left: var(--space-1);
    padding: var(--space-1);
    pointer-events: auto;
    position: absolute;
    top: 0.5rem;
    z-index: 3;
  }

  .timeline-debug button {
    margin-top: var(--space-compact);
  }

  .viewport {
    flex: 1;
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

  .items {
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

  :global(.jump-to-latest) {
    bottom: 1rem;
    box-shadow: var(--shadow-float);
    left: 50%;
    position: absolute;
    transform: translateX(-50%);
    z-index: 1;
  }
</style>
