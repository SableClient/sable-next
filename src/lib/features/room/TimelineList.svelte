<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { createVirtualizer } from '@tanstack/svelte-virtual';

  import type { TimelineItemView } from '@/generated/TimelineItemView';
  import { i18n } from '$lib/i18n';
  import type { RoomTimeline } from '$lib/rooms/timeline.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';

  import TimelineItem from './TimelineItem.svelte';
  import { isCollapsed } from './timeline-format';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';

  const HISTORY_PREFETCH_ITEMS = 10;
  const HISTORY_LOAD_THRESHOLD = 80;
  const JUMP_TO_LATEST_THRESHOLD = 80;

  interface Props {
    timeline: RoomTimeline;
    focusEventId?: string | null;
    onRequestHistory: () => Promise<boolean>;
    onRequestFuture: () => Promise<void>;
    onRead: (eventId: string) => Promise<void>;
  }

  let {
    timeline,
    focusEventId = null,
    onRequestHistory,
    onRequestFuture,
    onRead,
  }: Props = $props();
  let viewport = $state<HTMLDivElement | null>(null);
  let nearLatest = $state(true);
  let userScrollPending = false;
  let upwardScrollPending = false;
  let lastTouchY: number | null = null;
  let initialHistoryRequested = $state(false);
  let historyRequestPending = $state(false);
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
  let configuredItems = initialItems;
  let anchorGeneration = 0;
  let historyViewportAnchor: Omit<ViewportAnchor, 'index'> | null = null;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    estimateSize: () => 72,
    getItemKey: (index) => initialItems[index]?.id ?? 'missing',
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: JUMP_TO_LATEST_THRESHOLD,
    overscan: 8,
  });

  interface ViewportAnchor {
    id: string;
    index: number;
    offset: number;
  }

  function captureVisibleAnchor(
    items: readonly TimelineItemView[]
  ): Omit<ViewportAnchor, 'index'> | null {
    if (!viewport) return null;

    const eventIds = new Set(items.filter((item) => item.event_id !== null).map((item) => item.id));
    const viewportRect = viewport.getBoundingClientRect();
    let partialAnchor: Omit<ViewportAnchor, 'index'> | null = null;
    for (const element of viewport.querySelectorAll<HTMLElement>('.item')) {
      const id = element.dataset.itemId;
      if (!id || !eventIds.has(id)) continue;

      const rect = element.getBoundingClientRect();
      if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) continue;
      const anchor = { id, offset: rect.top - viewportRect.top };
      if (rect.top >= viewportRect.top) return anchor;
      partialAnchor ??= anchor;
    }
    return partialAnchor;
  }

  function resolveViewportAnchor(
    anchor: Omit<ViewportAnchor, 'index'>,
    items: readonly TimelineItemView[]
  ): ViewportAnchor | null {
    const index = items.findIndex((item) => item.id === anchor.id);
    return index < 0 ? null : { ...anchor, index };
  }

  function captureViewportAnchor(
    previousItems: readonly TimelineItemView[],
    nextItems: readonly TimelineItemView[]
  ): ViewportAnchor | null {
    if (!viewport || previousItems.length === 0 || scrollMode.kind === 'initialLive') return null;

    const anchor = captureVisibleAnchor(previousItems);
    if (!anchor) return null;
    const previousIndex = previousItems.findIndex((item) => item.id === anchor.id);
    const resolved = resolveViewportAnchor(anchor, nextItems);
    return resolved && resolved.index > previousIndex ? resolved : null;
  }

  async function restoreViewportAnchor(anchor: ViewportAnchor, generation: number): Promise<void> {
    await tick();
    const activeViewport = viewport;
    if (!activeViewport || generation !== anchorGeneration) return;

    get(virtualizer).scrollToIndex(anchor.index, { align: 'start' });
    await tick();
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise(requestAnimationFrame);
      if (generation !== anchorGeneration) return;

      const element = Array.from(activeViewport.querySelectorAll<HTMLElement>('.item')).find(
        (item) => item.dataset.itemId === anchor.id
      );
      if (!element) return;
      const offset =
        element.getBoundingClientRect().top - activeViewport.getBoundingClientRect().top;
      const delta = offset - anchor.offset;
      if (Math.abs(delta) > 0.5) get(virtualizer).scrollBy(delta);
    }
  }

  function cancelAnchorRestore(): void {
    anchorGeneration += 1;
    historyViewportAnchor = null;
  }

  $effect.pre(() => {
    const items = timeline.items;
    const anchor = historyViewportAnchor ? null : captureViewportAnchor(configuredItems, items);
    const instance = get(virtualizer);
    instance.setOptions({
      count: items.length,
      getScrollElement: () => viewport,
      estimateSize: () => 72,
      // TanStack compares the previous and next key functions during prepends.
      // Each function must retain the item ordering it was created for.
      getItemKey: (index) => items[index]?.id ?? 'missing',
      anchorTo: 'end',
      followOnAppend: true,
      scrollEndThreshold: JUMP_TO_LATEST_THRESHOLD,
      overscan: 8,
    });
    configuredItems = items;
    const generation = ++anchorGeneration;
    if (anchor) void restoreViewportAnchor(anchor, generation);
  });

  $effect(() => {
    if (timeline.backwardPagination === 'loading' || !historyViewportAnchor) return;
    const anchor = resolveViewportAnchor(historyViewportAnchor, timeline.items);
    if (!anchor) {
      historyViewportAnchor = null;
      return;
    }

    const generation = ++anchorGeneration;
    void restoreViewportAnchor(anchor, generation).finally(() => {
      if (generation === anchorGeneration) historyViewportAnchor = null;
    });
  });

  $effect(() => {
    if (timeline.loading || timeline.items.length === 0 || !viewport) return;

    const controller = new AbortController();
    void (async () => {
      await tick();
      await new Promise(requestAnimationFrame);
      if (controller.signal.aborted) return;
      const focusedEventId = scrollMode.kind === 'focused' ? scrollMode.eventId : null;
      const focusIndex = focusedEventId
        ? timeline.items.findIndex((item) => item.event_id === focusedEventId)
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
          requestHistory();
          return;
        }
        if (historyRequestPending || timeline.backwardPagination === 'loading') return;
        get(virtualizer).scrollToEnd({ behavior: 'auto' });
        nearLatest = true;
        scrollMode = { kind: 'followingLive' };
      }
    })();
    return () => {
      controller.abort();
    };
  });

  function measure(node: HTMLDivElement): void {
    get(virtualizer).measureElement(node);
  }

  function onScroll(): void {
    if (!viewport) return;
    const requestedOlderHistory = upwardScrollPending;
    nearLatest = get(virtualizer).isAtEnd();
    if (timeline.mode.kind === 'live' && scrollMode.kind !== 'initialLive') {
      if (nearLatest) scrollMode = { kind: 'followingLive' };
      else if (userScrollPending || scrollMode.kind === 'readingHistory') {
        scrollMode = { kind: 'readingHistory' };
      }
    }
    userScrollPending = false;
    if (requestedOlderHistory) requestHistoryAtTop();
    const newestVisibleIndex = get(virtualizer).getVirtualItems().at(-1)?.index;
    if (
      scrollMode.kind === 'focused' &&
      timeline.forwardPagination === 'idle' &&
      newestVisibleIndex !== undefined &&
      newestVisibleIndex >= timeline.items.length - HISTORY_PREFETCH_ITEMS
    ) {
      void onRequestFuture();
    }
  }

  function requestHistoryAtTop(): void {
    if (
      !viewport ||
      historyRequestPending ||
      timeline.backwardPagination !== 'idle' ||
      viewport.scrollTop > HISTORY_LOAD_THRESHOLD
    ) {
      return;
    }
    requestHistory();
  }

  function markWheelScroll(event: WheelEvent): void {
    cancelAnchorRestore();
    userScrollPending = true;
    upwardScrollPending = event.deltaY < 0;
    if (upwardScrollPending) requestHistoryAtTop();
  }

  function requestHistory(): void {
    if (historyRequestPending || timeline.backwardPagination !== 'idle') return;
    upwardScrollPending = false;
    if (scrollMode.kind !== 'initialLive') {
      historyViewportAnchor = captureVisibleAnchor(configuredItems);
    }
    historyRequestPending = true;
    const settle = (): void => {
      historyRequestPending = false;
    };
    void onRequestHistory().then(settle, settle);
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
      cancelAnchorRestore();
      userScrollPending = true;
      upwardScrollPending =
        event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home';
      if (upwardScrollPending) {
        requestHistoryAtTop();
      }
    }
  }

  function markTouchStart(event: TouchEvent): void {
    cancelAnchorRestore();
    userScrollPending = true;
    lastTouchY = event.touches.item(0)?.clientY ?? null;
  }

  function markTouchMove(event: TouchEvent): void {
    const touchY = event.touches.item(0)?.clientY;
    if (touchY === undefined || lastTouchY === null) return;
    userScrollPending = true;
    upwardScrollPending = touchY > lastTouchY;
    lastTouchY = touchY;
    if (upwardScrollPending) requestHistoryAtTop();
  }

  function markTouchEnd(): void {
    lastTouchY = null;
  }

  function userScrollMarker(node: HTMLDivElement): () => void {
    node.addEventListener('wheel', markWheelScroll);
    node.addEventListener('touchstart', markTouchStart);
    node.addEventListener('touchmove', markTouchMove);
    node.addEventListener('touchend', markTouchEnd);
    node.addEventListener('touchcancel', markTouchEnd);
    node.addEventListener('keydown', markKeyScroll);
    return () => {
      node.removeEventListener('wheel', markWheelScroll);
      node.removeEventListener('touchstart', markTouchStart);
      node.removeEventListener('touchmove', markTouchMove);
      node.removeEventListener('touchend', markTouchEnd);
      node.removeEventListener('touchcancel', markTouchEnd);
      node.removeEventListener('keydown', markKeyScroll);
    };
  }

  function jumpToLatest(): void {
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
  <div class="timeline-viewport">
    <div
      bind:this={viewport}
      class="viewport"
      aria-label={$i18n.t('timeline.label')}
      onscroll={onScroll}
      {@attach userScrollMarker}
      role="log"
    >
      <div class="items" style:height={String($virtualizer.getTotalSize()) + 'px'}>
        {#each $virtualizer.getVirtualItems() as virtualItem (virtualItem.key)}
          {@const item = timeline.items[virtualItem.index]}
          {#if item}
            <div
              class="item"
              data-event-id={item.event_id ?? undefined}
              data-item-id={item.id}
              data-index={virtualItem.index}
              style:transform={'translateY(' + String(virtualItem.start) + 'px)'}
              {@attach measure}
            >
              <TimelineItem {item} collapsed={isCollapsed(timeline.items, virtualItem.index)} />
            </div>
          {/if}
        {/each}
      </div>
    </div>
  </div>

  {#if scrollMode.kind === 'initialLive'}
    <div class="loading" aria-label={$i18n.t('timeline.loading')} role="status">
      <Spinner />
    </div>
  {/if}

  {#if timeline.mode.kind === 'live' && scrollMode.kind === 'readingHistory' && timeline.items.length > 0}
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
  }

  .viewport {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
  }

  .loading {
    align-items: center;
    display: flex;
    inset: 0;
    justify-content: center;
    pointer-events: none;
    position: absolute;
    z-index: 1;
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
