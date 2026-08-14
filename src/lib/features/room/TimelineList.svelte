<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
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
  import { isCollapsed, visibleTimelineItems } from './timeline-format';
  import { timelinePreferences } from '$lib/settings/timeline-preferences.svelte';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';

  const HISTORY_PREFETCH_ITEMS = 10;
  const HISTORY_FILL_MAX_PAGES = 4;
  const HISTORY_REQUEST_MIN_INTERVAL = 300;
  const JUMP_TO_LATEST_THRESHOLD = 80;
  const WHEEL_GESTURE_END_DELAY = 150;
  const localEchoItemIds = new SvelteSet<string>();
  const TIMELINE_DEBUG_ENABLED =
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('timelineDebug');

  function timelineEventKey(item: TimelineItemView | undefined): string | null {
    if (!item) return null;
    if (item.transaction_id) localEchoItemIds.add(item.id);
    if (localEchoItemIds.has(item.id)) return `item:${item.id}`;
    if (item.event_id) return `event:${item.event_id}`;
    if (item.transaction_id) return `transaction:${item.transaction_id}`;
    return null;
  }

  function timelineItemKey(items: readonly TimelineItemView[], index: number): string {
    if (index < 0 || index >= items.length) return 'missing';
    const item = items[index];
    const eventKey = timelineEventKey(item);
    if (eventKey) return eventKey;
    if (item.content.kind === 'date_divider' || item.content.kind === 'timeline_start') {
      for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
        const nextEventKey = timelineEventKey(items[nextIndex]);
        if (nextEventKey) return `boundary:${item.id}:${nextEventKey}`;
      }
    }
    return `item:${item.id}`;
  }

  // Mirrors TimelineItem's stylesheet, which is written in `rem`: pixel
  // constants here would drift on any root font size but 16px.
  const MEDIA_MAX_REM = 32;
  const MEDIA_MIN_REM = 15;
  const STICKER_WIDTH_REM = 9.5;
  const MESSAGE_INSET_REM = 4;
  const FILE_HEIGHT_REM = 1.75;
  const MESSAGE_CHROME_REM = 2.75;
  const CAPTION_HEIGHT_REM = 1.5;
  const REPLY_PREVIEW_REM = 1.875;
  const REACTIONS_REM = 1.875;
  const COLLAPSED_MESSAGE_REM = 3;
  const MESSAGE_REM = 4.5;
  const DATE_DIVIDER_REM = 3.5;
  const READ_MARKER_REM = 2;
  const SEPARATOR_REM = 2.5;
  const STATE_ROW_REM = 1.5;
  const DEBUG_ROW_REM = 2.25;
  const UNDECRYPTABLE_REM = 2.5;
  // The UA audio control does not scale with the font size.
  const AUDIO_HEIGHT_PX = 58;
  // Track MediaImage's 800x600 default and MediaContent's 16/9 video box.
  const PICTURE_RATIO = 0.75;
  const VIDEO_RATIO = 9 / 16;

  function rootFontSize(): number {
    if (typeof document === 'undefined') return 16;
    const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.isFinite(size) && size > 0 ? size : 16;
  }

  function inverseAspectRatio(
    width: number | null,
    height: number | null,
    fallback: number
  ): number {
    if (width === null || height === null || width <= 0 || height <= 0) return fallback;
    return height / width;
  }

  function estimateTimelineItemSize(
    items: readonly TimelineItemView[],
    index: number,
    viewportWidth: number,
    rem: number
  ): number {
    const item = items[index];
    // The avatar column and the page gutters sit outside the message box.
    const contentWidth = Math.min(
      MEDIA_MAX_REM * rem,
      Math.max(MEDIA_MIN_REM * rem, viewportWidth - MESSAGE_INSET_REM * rem)
    );
    const chrome = MESSAGE_CHROME_REM * rem;
    const trimmings =
      (item.in_reply_to ? REPLY_PREVIEW_REM * rem : 0) +
      (item.reactions.length > 0 ? REACTIONS_REM * rem : 0);
    switch (item.content.kind) {
      case 'message':
        return (isCollapsed(items, index) ? COLLAPSED_MESSAGE_REM : MESSAGE_REM) * rem + trimmings;
      case 'image': {
        const ratio = inverseAspectRatio(item.content.width, item.content.height, PICTURE_RATIO);
        const caption = item.content.body ? CAPTION_HEIGHT_REM * rem : 0;
        return Math.min(MEDIA_MAX_REM * rem, contentWidth * ratio) + chrome + caption + trimmings;
      }
      case 'sticker': {
        const ratio = inverseAspectRatio(item.content.width, item.content.height, PICTURE_RATIO);
        return STICKER_WIDTH_REM * rem * ratio + chrome + trimmings;
      }
      case 'video': {
        const ratio = inverseAspectRatio(item.content.width, item.content.height, VIDEO_RATIO);
        return contentWidth * ratio + chrome + trimmings;
      }
      case 'audio':
        return AUDIO_HEIGHT_PX + chrome + trimmings;
      case 'file':
        return FILE_HEIGHT_REM * rem + chrome + trimmings;
      case 'date_divider':
        return DATE_DIVIDER_REM * rem;
      case 'read_marker':
        return READ_MARKER_REM * rem;
      case 'membership':
      case 'profile_change':
      case 'redacted':
      case 'unsupported':
        return STATE_ROW_REM * rem;
      case 'state_event':
        return DEBUG_ROW_REM * rem;
      case 'unable_to_decrypt':
        return UNDECRYPTABLE_REM * rem;
      default:
        return SEPARATOR_REM * rem;
    }
  }

  interface TimelineDebugSample {
    time: number;
    scrollTop: number;
    scrollHeight: number;
    contentDelta: number;
    distanceFromEnd: number;
    frameDuration: number;
    maxFrameDuration: number;
    frameDelta: number;
    maxFrameDelta: number;
    anchorKey: string | null;
    anchorTop: number | null;
    visualDelta: number;
    maxVisualDelta: number;
    firstVirtualIndex: number | null;
    lastVirtualIndex: number | null;
    isScrolling: boolean;
    scrollMode: ScrollMode['kind'];
    backwardPagination: RoomTimeline['backwardPagination'];
  }

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
  let userScrollPending = false;
  let upwardScrollPending = false;
  let lastTouchY: number | null = null;
  let initialHistoryRequested = $state(false);
  let historyRequestPending = $state(false);
  let historyRequestQueued = false;
  let historyRequestEligible = false;
  let historyInputArmed = true;
  let historyFillActive = false;
  let historyFillPages = 0;
  let historyFillTimer: ReturnType<typeof setTimeout> | null = null;
  let historyLastRequestStartedAt = 0;
  let virtualizerWasScrolling = false;
  let virtualizerTotalSize = 0;
  let virtualizerViewportSize = 0;
  let wheelGestureTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelGestureActive = false;
  let wheelUsesNativeScrollEnd = false;
  let focusAnchored = false;
  type ScrollMode =
    | { kind: 'initialLive' }
    | { kind: 'followingLive' }
    | { kind: 'readingHistory' }
    | { kind: 'focused'; eventId: string };
  let scrollMode = $state<ScrollMode>(
    untrack(() =>
      focusEventId === null ? { kind: 'initialLive' } : { kind: 'focused', eventId: focusEventId }
    )
  );
  const initialItems: readonly TimelineItemView[] = [];
  let initialEndReconciliationPending = false;
  let followingEndReconciliationPending = false;
  let timelineDebugSample = $state<TimelineDebugSample | null>(null);
  let timelineDebugSamples: TimelineDebugSample[] = [];
  let historyDebugItems: readonly TimelineItemView[] = initialItems;
  let historyDebugChange = 0;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    estimateSize: (index) => estimateTimelineItemSize(initialItems, index, 512, 16),
    getItemKey: (index) => timelineItemKey(initialItems, index),
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: JUMP_TO_LATEST_THRESHOLD,
    useScrollendEvent: true,
    overscan: 8,
    onChange: handleVirtualizerChange,
  });

  $effect(() => {
    if (!TIMELINE_DEBUG_ENABLED) return;
    const samples: TimelineDebugSample[] = [];
    timelineDebugSamples = samples;
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
        samples.push(nextSample);
        if (samples.length > 1_800) samples.shift();
        if (time - lastHudUpdate >= 100) {
          lastHudUpdate = time;
          timelineDebugSample = nextSample;
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
    const first = timelineDebugSamples[0];
    const transitions = timelineDebugSamples.filter((sample, index, samples) => {
      if (index === 0) return true;
      const previous = samples[index - 1];
      return (
        Math.abs(sample.frameDelta) >= 100 ||
        Math.abs(sample.contentDelta) >= 100 ||
        sample.frameDuration >= 24 ||
        Math.abs(sample.visualDelta) >= 16 ||
        sample.scrollMode !== previous.scrollMode ||
        sample.backwardPagination !== previous.backwardPagination ||
        sample.isScrolling !== previous.isScrolling
      );
    });
    const last = timelineDebugSamples.at(-1);
    const largestFrame = timelineDebugSamples.reduce<TimelineDebugSample | null>(
      (largest, sample) =>
        !largest || Math.abs(sample.frameDelta) > Math.abs(largest.frameDelta) ? sample : largest,
      null
    );
    const slowestFrame = timelineDebugSamples.reduce<TimelineDebugSample | null>(
      (slowest, sample) =>
        !slowest || sample.frameDuration > slowest.frameDuration ? sample : slowest,
      null
    );
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          samples: timelineDebugSamples.length,
          start: first,
          end: last,
          largestFrame,
          slowestFrame,
          transitions: transitions.slice(-40),
        },
        null,
        2
      )
    );
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
    if (scrollingEnded) {
      flushHistoryRequest();
      finishWheelGesture();
    }
  }

  function scheduleFollowingEndReconciliation(): void {
    if (followingEndReconciliationPending) return;

    followingEndReconciliationPending = true;
    void tick().then(() => {
      followingEndReconciliationPending = false;
      if (scrollMode.kind !== 'followingLive' || userScrollPending || !viewport) return;
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
      if (!historyRequestPending && timeline.backwardPagination !== 'loading') {
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
    const edgesChanged =
      previousItems.length !== items.length ||
      timelineItemKey(previousItems, 0) !== timelineItemKey(items, 0) ||
      timelineItemKey(previousItems, previousItems.length - 1) !==
        timelineItemKey(items, items.length - 1);
    if (timelineItemKey(previousItems, 0) !== timelineItemKey(items, 0)) {
      historyRequestQueued = false;
      historyRequestEligible = false;
    }
    const change = edgesChanged ? (historyDebugChange += 1) : historyDebugChange;
    if (edgesChanged) {
      historyDebugLog('items:before', {
        change,
        previousCount: previousItems.length,
        nextCount: items.length,
        previousFirstKey: timelineItemKey(previousItems, 0),
        nextFirstKey: timelineItemKey(items, 0),
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
        estimateTimelineItemSize(items, index, viewport?.clientWidth ?? MEDIA_MAX_REM * rem, rem),
      // TanStack compares the previous and next key functions during prepends.
      // Each function must retain the item ordering it was created for.
      getItemKey: (index) => timelineItemKey(items, index),
      anchorTo: 'end',
      followOnAppend: true,
      scrollEndThreshold: JUMP_TO_LATEST_THRESHOLD,
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
          beginHistoryFill();
          requestHistory();
          return;
        }
        if (historyRequestPending || timeline.backwardPagination === 'loading') return;
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
    if (!viewport) return null;
    const activeViewport = viewport;
    const viewportRect = activeViewport.getBoundingClientRect();
    let anchor: object | null = null;
    for (const item of activeViewport.querySelectorAll<HTMLElement>('.item')) {
      const rect = item.getBoundingClientRect();
      const top = rect.top - viewportRect.top;
      const bottom = rect.bottom - viewportRect.top;
      if (top >= 0 && bottom <= activeViewport.clientHeight) {
        anchor = {
          id: item.dataset.itemId ?? null,
          eventId: item.dataset.eventId ?? null,
          index: item.dataset.index ?? null,
          top,
          bottom,
        };
        break;
      }
    }
    const virtualItems = get(virtualizer).getVirtualItems();
    return {
      scrollTop: activeViewport.scrollTop,
      scrollHeight: activeViewport.scrollHeight,
      clientHeight: activeViewport.clientHeight,
      firstVirtualIndex: virtualItems[0]?.index ?? null,
      lastVirtualIndex: virtualItems.at(-1)?.index ?? null,
      anchor: anchor ?? null,
      scrollMode: scrollMode.kind,
    };
  }

  function historyDebugLog(event: string, details: object): void {
    if (!TIMELINE_DEBUG_ENABLED) return;
    console.log(`[timeline-history] ${event} ${JSON.stringify(details)}`);
  }

  function onScroll(): void {
    if (!viewport) return;
    const requestedOlderHistory = upwardScrollPending;
    nearLatest =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
      JUMP_TO_LATEST_THRESHOLD;
    if (timeline.mode.kind === 'live' && scrollMode.kind !== 'initialLive') {
      if (nearLatest && scrollMode.kind !== 'followingLive') {
        scrollMode = { kind: 'followingLive' };
      } else if (!nearLatest && scrollMode.kind !== 'readingHistory' && userScrollPending) {
        scrollMode = { kind: 'readingHistory' };
      }
    }
    userScrollPending = false;
    if (requestedOlderHistory && historyInputArmed) queueHistoryRequest();
    const newestVisibleIndex = get(virtualizer).getVirtualItems().at(-1)?.index;
    if (
      scrollMode.kind === 'focused' &&
      timeline.forwardPagination === 'idle' &&
      newestVisibleIndex !== undefined &&
      newestVisibleIndex >= visibleItems.length - HISTORY_PREFETCH_ITEMS
    ) {
      void onRequestFuture();
    }
  }

  function flushHistoryRequest(): void {
    if (
      !historyRequestQueued ||
      !historyRequestEligible ||
      !viewport ||
      historyRequestPending ||
      timeline.backwardPagination !== 'idle' ||
      !isNearOldestHistory()
    ) {
      return;
    }
    if (!historyFillActive) beginHistoryFill();
    historyInputArmed = false;
    requestHistory();
  }

  function beginHistoryFill(): void {
    cancelHistoryFillTimer();
    historyFillActive = true;
    historyFillPages = 0;
    historyInputArmed = false;
  }

  function finishHistoryFill(): void {
    cancelHistoryFillTimer();
    historyFillActive = false;
    historyFillPages = 0;
    historyInputArmed = true;
  }

  function cancelHistoryFillTimer(): void {
    if (historyFillTimer === null) return;
    clearTimeout(historyFillTimer);
    historyFillTimer = null;
  }

  function scheduleHistoryFill(): void {
    cancelHistoryFillTimer();
    if (
      !historyFillActive ||
      historyFillPages >= HISTORY_FILL_MAX_PAGES ||
      timeline.backwardPagination === 'end' ||
      !isNearOldestHistory()
    ) {
      finishHistoryFill();
      return;
    }

    const delay = Math.max(
      0,
      historyLastRequestStartedAt + HISTORY_REQUEST_MIN_INTERVAL - performance.now()
    );
    historyFillTimer = setTimeout(continueHistoryFill, delay);
  }

  function continueHistoryFill(): void {
    historyFillTimer = null;
    if (!historyFillActive || !isNearOldestHistory()) {
      finishHistoryFill();
      return;
    }
    if (historyRequestPending || timeline.backwardPagination === 'loading') {
      historyFillTimer = setTimeout(continueHistoryFill, 50);
      return;
    }
    if (timeline.backwardPagination !== 'idle') {
      finishHistoryFill();
      return;
    }
    requestHistory();
  }

  function isNearOldestHistory(): boolean {
    if (!viewport) return false;
    const oldestVisibleIndex = get(virtualizer).getVirtualItemForOffset(viewport.scrollTop)?.index;
    // The virtualizer has no measurements in non-layout environments.
    if (oldestVisibleIndex === undefined) return viewport.scrollTop === 0;
    return oldestVisibleIndex < HISTORY_PREFETCH_ITEMS;
  }

  function queueHistoryRequest(): void {
    const wasEligible = historyRequestEligible;
    historyRequestQueued = true;
    historyRequestEligible ||= isNearOldestHistory();
    if (!wasEligible && historyRequestEligible) {
      historyDebugLog('gesture:eligible', {
        pagination: timeline.backwardPagination,
        viewport: historyDebugSnapshot(),
      });
    }
    flushHistoryRequest();
  }

  function markWheelScroll(event: WheelEvent): void {
    if (wheelGestureTimer !== null) clearTimeout(wheelGestureTimer);
    wheelGestureTimer = setTimeout(() => {
      wheelGestureTimer = null;
      if (!wheelUsesNativeScrollEnd || !get(virtualizer).isScrolling) finishWheelGesture();
    }, WHEEL_GESTURE_END_DELAY);
    wheelGestureActive = true;
    userScrollPending = true;
    upwardScrollPending = event.deltaY < 0;
    if (upwardScrollPending && historyInputArmed) {
      queueHistoryRequest();
    } else if (!upwardScrollPending) {
      finishHistoryFill();
      historyRequestQueued = false;
      historyRequestEligible = false;
    }
  }

  function finishWheelGesture(): void {
    if (!wheelGestureActive) return;
    wheelGestureActive = false;
    historyDebugLog('gesture:settled', {
      queued: historyRequestQueued,
      eligible: historyRequestEligible,
      pagination: timeline.backwardPagination,
      isScrolling: get(virtualizer).isScrolling,
      viewport: historyDebugSnapshot(),
    });
    if (historyRequestQueued) flushHistoryRequest();
    historyRequestQueued = false;
    historyRequestEligible = false;
    if (!historyFillActive) historyInputArmed = true;
    upwardScrollPending = false;
  }

  function markWheelScrollEnd(): void {
    if (wheelGestureTimer !== null) {
      clearTimeout(wheelGestureTimer);
      wheelGestureTimer = null;
    }
    finishWheelGesture();
  }

  function requestHistory(): void {
    if (historyRequestPending || timeline.backwardPagination !== 'idle') return;
    upwardScrollPending = false;
    historyRequestQueued = false;
    historyRequestEligible = false;
    historyRequestPending = true;
    historyFillPages += 1;
    historyLastRequestStartedAt = performance.now();
    historyDebugLog('request:start', {
      pagination: timeline.backwardPagination,
      viewport: historyDebugSnapshot(),
    });
    void onRequestHistory().then(
      (reachedEnd) => {
        historyRequestPending = false;
        historyDebugLog('request:settled', {
          pagination: timeline.backwardPagination,
          viewport: historyDebugSnapshot(),
        });
        if (reachedEnd) finishHistoryFill();
        else scheduleHistoryFill();
      },
      () => {
        historyRequestPending = false;
        finishHistoryFill();
      }
    );
  }

  function markKeyScroll(event: KeyboardEvent): void {
    if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'PageUp' ||
      event.key === 'PageDown' ||
      event.key === 'Home' ||
      event.key === 'End' ||
      event.key === ' '
    ) {
      userScrollPending = true;
      upwardScrollPending =
        event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home';
      if (upwardScrollPending && historyInputArmed) {
        queueHistoryRequest();
      } else if (!upwardScrollPending) {
        finishHistoryFill();
        historyRequestQueued = false;
        historyRequestEligible = false;
      }
    }
  }

  function markKeyEnd(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'PageUp' && event.key !== 'Home') return;
    historyRequestQueued = false;
    historyRequestEligible = false;
    historyInputArmed = true;
    upwardScrollPending = false;
  }

  function markTouchStart(event: TouchEvent): void {
    userScrollPending = true;
    historyInputArmed = true;
    lastTouchY = event.touches.item(0)?.clientY ?? null;
  }

  function markTouchMove(event: TouchEvent): void {
    const touchY = event.touches.item(0)?.clientY;
    if (touchY === undefined || lastTouchY === null) return;
    userScrollPending = true;
    upwardScrollPending = touchY > lastTouchY;
    lastTouchY = touchY;
    if (upwardScrollPending) queueHistoryRequest();
    else historyRequestQueued = false;
  }

  function markTouchEnd(): void {
    lastTouchY = null;
    historyRequestQueued = false;
    historyRequestEligible = false;
    historyInputArmed = true;
    upwardScrollPending = false;
  }

  function markPointerStart(): void {
    userScrollPending = true;
  }

  function markPointerEnd(): void {
    userScrollPending = false;
  }

  function userScrollMarker(node: HTMLDivElement): () => void {
    wheelUsesNativeScrollEnd = 'onscrollend' in node;
    node.addEventListener('wheel', markWheelScroll, { passive: true });
    node.addEventListener('scrollend', markWheelScrollEnd);
    node.addEventListener('touchstart', markTouchStart, { passive: true });
    node.addEventListener('touchmove', markTouchMove, { passive: true });
    node.addEventListener('touchend', markTouchEnd);
    node.addEventListener('touchcancel', markTouchEnd);
    node.addEventListener('pointerdown', markPointerStart, { passive: true });
    node.addEventListener('pointerup', markPointerEnd, { passive: true });
    node.addEventListener('pointercancel', markPointerEnd, { passive: true });
    node.addEventListener('keydown', markKeyScroll);
    node.addEventListener('keyup', markKeyEnd);
    return () => {
      if (wheelGestureTimer !== null) clearTimeout(wheelGestureTimer);
      finishHistoryFill();
      node.removeEventListener('wheel', markWheelScroll);
      node.removeEventListener('scrollend', markWheelScrollEnd);
      node.removeEventListener('touchstart', markTouchStart);
      node.removeEventListener('touchmove', markTouchMove);
      node.removeEventListener('touchend', markTouchEnd);
      node.removeEventListener('touchcancel', markTouchEnd);
      node.removeEventListener('pointerdown', markPointerStart);
      node.removeEventListener('pointerup', markPointerEnd);
      node.removeEventListener('pointercancel', markPointerEnd);
      node.removeEventListener('keydown', markKeyScroll);
      node.removeEventListener('keyup', markKeyEnd);
    };
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
    finishHistoryFill();
    historyRequestQueued = false;
    historyRequestEligible = false;
    historyInputArmed = true;
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

<div class="timeline-content">
  {#if TIMELINE_DEBUG_ENABLED && timelineDebugSample}
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
    transition: opacity 120ms ease-out;
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
    font-size: 0.6875rem;
    gap: 0.125rem;
    left: 0.5rem;
    padding: 0.5rem;
    pointer-events: auto;
    position: absolute;
    top: 0.5rem;
    z-index: 3;
  }

  .timeline-debug button {
    margin-top: 0.25rem;
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
    padding: 0.25rem var(--page-gutter);
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
