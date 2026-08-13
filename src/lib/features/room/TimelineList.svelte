<script lang="ts">
  import { tick } from 'svelte';
  import { get } from 'svelte/store';
  import { createVirtualizer } from '@tanstack/svelte-virtual';

  import { i18n } from '$lib/i18n';
  import type { RoomTimeline } from '$lib/rooms/timeline.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';

  import TimelineItem from './TimelineItem.svelte';
  import { isCollapsed, readReceiptEventId } from './timeline-format';

  interface Props {
    timeline: RoomTimeline;
    focusEventId?: string | null;
    onRequestHistory: () => Promise<void>;
    onRead: (eventId: string) => Promise<void>;
  }

  let { timeline, focusEventId = null, onRequestHistory, onRead }: Props = $props();
  let viewport = $state<HTMLDivElement | null>(null);
  let viewportHeight = $state(0);
  let paddingStart = $state(0);
  let nearLatest = $state(true);
  let documentVisible = $state(true);
  let initialAnchorComplete = $state(false);
  let didScrollToEnd = false;
  let didRequestInitialHistory = false;
  let lastReadEventId: string | null = null;

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    estimateSize: () => 72,
    getItemKey: (index) => timeline.items[index]?.id ?? 'missing',
    paddingStart: 0,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 8,
  });

  $effect(() => {
    get(virtualizer).setOptions({
      count: timeline.items.length,
      getScrollElement: () => viewport,
      estimateSize: () => 72,
      getItemKey: (index) => timeline.items[index]?.id ?? 'missing',
      paddingStart,
      anchorTo: 'end',
      followOnAppend: true,
      scrollEndThreshold: 80,
      overscan: 8,
    });
  });

  $effect(() => {
    const contentHeight = $virtualizer.getTotalSize() - paddingStart;
    const nextPaddingStart = Math.max(0, viewportHeight - contentHeight);
    if (nextPaddingStart !== paddingStart) paddingStart = nextPaddingStart;
  });

  $effect(() => {
    if (didScrollToEnd || timeline.loading || timeline.items.length === 0) return;
    didScrollToEnd = true;
    void (async () => {
      await tick();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const focusIndex = focusEventId
        ? timeline.items.findIndex((item) => item.event_id === focusEventId)
        : -1;
      if (focusIndex >= 0) get(virtualizer).scrollToIndex(focusIndex, { align: 'center' });
      else {
        get(virtualizer).scrollToEnd({ behavior: 'auto' });
        nearLatest = true;
      }
      initialAnchorComplete = true;

      if (focusIndex < 0 && !didRequestInitialHistory) {
        didRequestInitialHistory = true;
        void onRequestHistory();
      }
    })();
  });

  $effect(() => {
    if (
      focusEventId !== null ||
      !initialAnchorComplete ||
      !nearLatest ||
      timeline.items.length === 0
    )
      return;
    void (async () => {
      await tick();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      get(virtualizer).scrollToEnd({ behavior: 'auto' });
      nearLatest = true;
    })();
  });

  $effect(() => {
    const updateVisibility = () => {
      documentVisible = document.visibilityState === 'visible';
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  });

  $effect(() => {
    const eventId = readReceiptEventId(timeline.items, {
      focusEventId,
      initialAnchorComplete,
      nearLatest,
      documentVisible,
      lastReadEventId,
    });
    if (!eventId) return;
    lastReadEventId = eventId;
    void onRead(eventId);
  });

  function measure(node: HTMLDivElement): () => void {
    get(virtualizer).measureElement(node);
    return () => {
      get(virtualizer).measureElement(null);
    };
  }

  function onScroll(): void {
    const instance = get(virtualizer);
    nearLatest = instance.isAtEnd();
    const oldestVisibleIndex = instance.getVirtualItems().at(0)?.index;
    if (oldestVisibleIndex !== undefined && oldestVisibleIndex <= 10) {
      void onRequestHistory();
    }
  }

  function jumpToLatest(): void {
    get(virtualizer).scrollToEnd({ behavior: 'smooth' });
    nearLatest = true;
  }
</script>

{#if timeline.loading}
  <p class="loading">{$i18n.t('timeline.loading')}</p>
{/if}

{#if timeline.error}
  <Alert class="timeline-error" variant="critical" role="alert"
    >{$i18n.t('timeline.loadFailed')}</Alert
  >
{/if}

<div bind:this={viewport} bind:clientHeight={viewportHeight} class="viewport" onscroll={onScroll}>
  <div class="items" style:height={String($virtualizer.getTotalSize()) + 'px'}>
    {#each $virtualizer.getVirtualItems() as virtualItem (virtualItem.key)}
      {@const item = timeline.items[virtualItem.index]}
      {#if item}
        <div
          class="item"
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

{#if timeline.backwardPagination === 'loading'}
  <p class="history-status">{$i18n.t('timeline.loading')}</p>
{/if}

{#if !nearLatest && timeline.items.length > 0}
  <Button type="button" class="jump-to-latest" variant="primary" size="small" onclick={jumpToLatest}
    >{$i18n.t('timeline.jumpToLatest')}</Button
  >
{/if}

<style>
  .loading,
  .history-status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0.75rem 1rem;
  }

  :global(.timeline-error) {
    flex: 0 0 auto;
    font-size: var(--font-size-small);
  }

  .viewport {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
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
