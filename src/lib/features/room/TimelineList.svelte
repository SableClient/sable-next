<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import { fade } from 'svelte/transition';
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';

  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { motionMs, shouldReduceMotion } from '#lib/ui/motion.js';
  import {
    TimelineWindow,
    type TimelineEntry,
    type TimelineRow,
    type TimelineWindowState,
  } from '#lib/timeline/timeline-window.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import MessageContextMenu from './MessageContextMenu.svelte';
  import TimelineItem from './TimelineItem.svelte';
  import TimelineReadReceipt from './TimelineReadReceipt.svelte';
  import TimelineAnnouncements from './TimelineAnnouncements.svelte';
  import TimelineSkeleton from './TimelineSkeleton.svelte';
  import TypingIndicator from './TypingIndicator.svelte';
  import type { MatrixLink } from './matrix-link';
  import {
    isCollapsed,
    latestEventId,
    personaLookup,
    unreadCountAfter,
    visibleTimelineItems,
  } from './timeline-format';
  import { TimelineHistoryController } from './timeline-history';
  import { TimelineIdentityTracker } from './timeline-identity';
  import {
    estimatedColumnPx,
    estimateRowSize,
    mediaColumnPx,
    TIMELINE_LAYOUT,
    TIMELINE_LAYOUT_STYLE,
  } from './timeline-layout';

  const MAX_EMPTY_REFILLS = 5;

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
    onToggleReaction?: (
      eventId: string,
      key: string,
      sourcePack?: import('#src/generated/protocol').ImageSourcePackView | null
    ) => void;
    onReply?: (eventId: string) => void;
    onOpenThread?: (rootEventId: string) => void;
    onEdit?: (eventId: string, body: string, html: string | null) => void;
    onDelete?: (eventId: string, reason: string | null) => void;
    roomId?: string;
    members?: readonly MemberView[];
    onJumpToEvent?: (eventId: string) => void;
    onJumpToLive?: () => void;
    onOpenMedia?: (eventId: string) => void;
    onPersonaAvatarClick?: (source: string, displayName: string) => void;
    onVotePoll?: (eventId: string, answers: string[]) => void;
    onEndPoll?: (eventId: string) => void;
    readOnly?: boolean;
    canRedactOthers?: boolean;
    encrypted?: boolean | null;
    scrollLocked?: boolean;
    nearLatest?: boolean;
    followingLive?: boolean;
    typingLabel?: string | null;
    footTrailing?: Snippet;
  }

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
    onJumpToLive,
    onOpenMedia,
    onPersonaAvatarClick,
    onVotePoll,
    onEndPoll,
    readOnly = false,
    canRedactOthers = false,
    encrypted = null,
    scrollLocked = false,
    nearLatest = $bindable(true),
    /* eslint-disable-next-line no-useless-assignment */
    followingLive = $bindable(false),
    typingLabel = null,
    footTrailing,
  }: Props = $props();

  interface RowValue {
    item: TimelineItemView;
    collapsed: boolean;
    groupStart: boolean;
    unreadCount: number;
  }
  const identity = new TimelineIdentityTracker();
  let followingRead = $state(false);
  let allItems = $derived(visibleTimelineItems(timeline.items, preferences, { readOnly }));
  let visibleItems = $derived(
    followingRead ? allItems.filter((item) => item.content.kind !== 'read_marker') : allItems
  );
  let entries = $derived.by((): readonly TimelineEntry<RowValue>[] => {
    identity.reconcile(visibleItems);
    return visibleItems.map((item, index) => {
      const collapsed = isCollapsed(visibleItems, index, preferences.replyPreviewStyle);
      return {
        key: identity.key(visibleItems, index),
        value: {
          item,
          collapsed,
          groupStart: index > 0 && !collapsed,
          unreadCount:
            item.content.kind === 'read_marker' ? unreadCountAfter(visibleItems, index) : 0,
        },
      };
    });
  });
  let rows = $state.raw<readonly TimelineRow<RowValue>[]>([]);
  let windowState = $state.raw<TimelineWindowState>({
    start: 0,
    end: 0,
    firstVisible: null,
    lastVisible: null,
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
  let disposed = false;
  let historyExhausted = $state(false);
  let historyRequestPending = $state(false);
  let historyTask: Promise<boolean> | null = null;
  let refillPending = false;
  let refillItems: readonly TimelineItemView[] | null = null;
  let emptyRefills = 0;
  let focusFilling = false;
  let focusNavigation: AbortController | null = null;
  let visibleItemCount = 0;
  let personas = $derived(personaLookup(timeline.items));
  let personaOpen = $state(false);
  let noHistory = $derived(
    visibleItems.length === 0 && (historyExhausted || timeline.backwardPagination === 'end')
  );
  let awaitingContent = $derived(
    visibleItems.length === 0 && timeline.error === null && !noHistory
  );
  let readEventId = $derived.by(() => {
    if (!revealed || !viewport) return null;
    if (windowState.pinned) return latestEventId(rows.map((row) => row.value.item));
    const bottom = viewport.getBoundingClientRect().bottom;
    let seen: string | null = null;
    for (const row of viewport.querySelectorAll<HTMLElement>('.item[data-event-id]')) {
      if (row.getBoundingClientRect().bottom > bottom) break;
      seen = row.dataset.eventId ?? seen;
    }
    return seen;
  });
  let readMarker = $derived.by(() => {
    const index = visibleItems.findIndex((item) => item.content.kind === 'read_marker');
    return index >= 0 ? { index, count: unreadCountAfter(visibleItems, index) } : null;
  });
  let stuckUnreadCount = $derived(
    readMarker !== null &&
      windowState.firstVisible !== null &&
      readMarker.index < windowState.firstVisible
      ? readMarker.count
      : 0
  );
  let historyLoading = $derived(
    revealed &&
      visibleItems.length > 0 &&
      (historyRequestPending || timeline.backwardPagination === 'loading')
  );
  let live = $derived(timeline.mode.kind === 'live');
  let futureLoading = $derived(
    revealed && !live && visibleItems.length > 0 && timeline.forwardPagination === 'loading'
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
  function canRefill(): boolean {
    const items = timeline.items;
    if (items !== refillItems) {
      refillItems = items;
      emptyRefills = 0;
    }
    if (emptyRefills >= MAX_EMPTY_REFILLS) return false;
    emptyRefills += 1;
    return true;
  }
  function requestHistory(): Promise<boolean> {
    if (historyTask) return historyTask;
    historyRequestPending = true;
    historyTask = onRequestHistory().finally(() => {
      historyRequestPending = false;
      historyTask = null;
    });
    return historyTask;
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
  function measureMediaColumn(node: HTMLElement): number {
    const main = node.querySelector<HTMLElement>('.message-main');
    return mediaColumnPx(main?.clientWidth ?? estimatedColumnPx(node.clientWidth));
  }
  function windowChanged(state: TimelineWindowState): void {
    const wasScrolling = windowState.scrolling;
    windowState = state;
    const node = viewport;
    if (node !== null) mediaColumn = measureMediaColumn(node);
    const distance = node === null ? 0 : node.scrollHeight - node.clientHeight - node.scrollTop;
    jumpToLatestVisible =
      !state.pinned &&
      (state.end !== entries.length ||
        (node !== null && distance >= node.clientHeight * TIMELINE_LAYOUT.jumpToLatestPages));
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
    historyController.observeScroll(delta < 0, nearLatest);
    if (
      timeline.mode.kind !== 'live' &&
      timeline.forwardPagination === 'idle' &&
      windowState.lastVisible !== null &&
      windowState.lastVisible >= entries.length - TIMELINE_LAYOUT.historyPrefetchItems
    ) {
      void onRequestFuture().catch(() => {});
    }
  }
  function mountWindow(node: HTMLDivElement): () => void {
    const canvas = node.querySelector<HTMLElement>('.items');
    const content = node.querySelector<HTMLElement>('.window-rows');
    if (!canvas || !content) throw new Error('Timeline window elements are missing');
    mediaColumn = measureMediaColumn(node);
    const widths = new ResizeObserver(() => {
      mediaColumn = measureMediaColumn(node);
    });
    widths.observe(node);
    const engine = new TimelineWindow<RowValue>({
      viewport: node,
      canvas,
      content,
      render: async (next) => {
        rows = next;
        await tick();
      },
      onChange: windowChanged,
      onScroll: readerScrolled,
      onInteraction: () => focusNavigation?.abort(),
      isAnchor: ({ item }) => item.event_id !== null,
      estimateSize: ({ item }) => estimateRowSize(item.content, mediaColumn),
    });
    controller = engine;
    return () => {
      disposed = true;
      focusNavigation?.abort();
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
  async function fillFocusedViewport(
    engine: TimelineWindow<RowValue>,
    current: () => boolean
  ): Promise<void> {
    let emptyPages = 0;
    let deadline = performance.now() + TIMELINE_LAYOUT.initialFillSettleTimeout;
    while (current() && timeline.mode.kind === 'focused' && timeline.error === null) {
      const node = viewport;
      if (!node || node.scrollHeight - node.clientHeight > 1) break;
      if (timeline.forwardPagination === 'loading' || timeline.backwardPagination === 'loading') {
        if (performance.now() >= deadline) break;
        await new Promise((resolve) =>
          setTimeout(resolve, TIMELINE_LAYOUT.initialFillPollInterval)
        );
        continue;
      }
      if (emptyPages >= MAX_EMPTY_REFILLS) break;
      const before = timeline.items;
      if (timeline.forwardPagination !== 'end') await onRequestFuture();
      else if (!historyExhausted && timeline.backwardPagination !== 'end') {
        const end = await requestHistory();
        if (!current()) break;
        historyExhausted = end;
      } else break;
      if (!current() || timeline.error !== null) break;
      emptyPages = timeline.items === before ? emptyPages + 1 : 0;
      deadline = performance.now() + TIMELINE_LAYOUT.initialFillSettleTimeout;
      await engine.update(entries);
      await new Promise(requestAnimationFrame);
    }
  }
  async function positionFocus(
    engine: TimelineWindow<RowValue>,
    target: string,
    key: string,
    smooth: boolean
  ): Promise<void> {
    focusNavigation?.abort();
    const navigation = new AbortController();
    focusNavigation = navigation;
    const mode = timeline.mode;
    const current = () =>
      !disposed && !navigation.signal.aborted && focusEventId === target && timeline.mode === mode;
    const needsFill =
      timeline.mode.kind === 'focused' &&
      viewport !== null &&
      viewport.scrollHeight - viewport.clientHeight <= 1;
    focusFilling = true;
    try {
      const moved = await engine.jumpTo(key, 'center', smooth && !needsFill, navigation.signal);
      if (!moved || !current() || !needsFill) return;
      await fillFocusedViewport(engine, current);
      if (current() && timeline.error === null)
        await engine.jumpTo(key, 'center', smooth, navigation.signal);
    } catch {
      return;
    } finally {
      if (focusNavigation === navigation) focusFilling = false;
    }
  }
  async function awaitPagination(): Promise<void> {
    const deadline = performance.now() + TIMELINE_LAYOUT.initialFillSettleTimeout;
    while (!disposed && timeline.backwardPagination === 'loading' && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.initialFillPollInterval));
    }
    await tick();
  }
  async function openTimeline(engine: TimelineWindow<RowValue>): Promise<void> {
    if (opening || disposed) return;
    opening = true;
    await tick();
    await new Promise(requestAnimationFrame);
    if (disposed) return;
    if (timeline.loading || (!timeline.hasSnapshot && !timeline.error)) {
      opening = false;
      return;
    }
    await engine.update(entries);
    if (focusEventId) {
      const target = focusEventId;
      const entry = entries.find(({ value }) => value.item.event_id === focusEventId);
      if (entry) handledFocus = target;
      revealed = true;
      if (entry) await positionFocus(engine, target, entry.key, false);
      return;
    }
    const unread = entries.find(({ value }) => value.item.content.kind === 'read_marker');
    if (!unread) revealed = true;
    filling = true;
    try {
      while (!disposed && engine.state.pinned && timeline.backwardPagination !== 'end') {
        const node = viewport;
        if (!node || timeline.items.length === 0) break;
        if (engine.contentHeight >= node.clientHeight || node.scrollHeight > node.clientHeight)
          break;
        if (timeline.backwardPagination === 'loading') {
          await awaitPagination();
          if (timeline.backwardPagination === 'loading') break;
        } else {
          if (!canRefill()) break;
          historyExhausted = await requestHistory();
          await awaitPagination();
          await engine.update(entries);
          await new Promise(requestAnimationFrame);
          if (historyExhausted) break;
        }
      }
      if (unread && !disposed && engine.state.pinned) await engine.jumpTo(unread.key, 'start');
    } catch {
      historyExhausted = false;
    } finally {
      filling = false;
      if (!disposed) revealed = true;
    }
  }
  $effect(() => {
    const count = visibleItems.length;
    if (count < visibleItemCount) historyExhausted = false;
    visibleItemCount = count;
    const engine = controller;
    const node = viewport;
    if (
      timeline.loading ||
      timeline.mode.kind === 'focused' ||
      timeline.error !== null ||
      !engine ||
      !revealed ||
      historyExhausted ||
      timeline.backwardPagination !== 'idle' ||
      historyRequestPending ||
      filling ||
      focusFilling ||
      refillPending
    )
      return;
    if (count > 0 && !(node && windowState.start === 0 && !fillsViewport(engine, node))) return;
    if (!canRefill()) return;
    refillPending = true;
    void requestHistory()
      .then((end) => {
        historyExhausted = end;
      })
      .catch(() => {})
      .finally(() => {
        refillPending = false;
      });
  });
  let sentEcho: string | null = null;
  $effect(() => {
    const engine = controller;
    const last = entries.at(-1)?.value.item;
    if (!engine || !revealed) return;
    const echo = last && last.is_own && last.event_id === null ? last.transaction_id : null;
    if (echo === null || echo === sentEcho) return;
    sentEcho = echo;
    if (untrack(() => nearLatest)) void engine.jumpTo(null, 'start');
  });
  let handledFocus: string | null = null;
  $effect(() => {
    void focusEventId;
    void timeline.mode;
    untrack(() => focusNavigation?.abort());
  });
  $effect(() => {
    const target = focusEventId;
    const engine = controller;
    if (!engine || !revealed || target === handledFocus) return;
    if (target === null) {
      handledFocus = null;
      return;
    }
    const entry = entries.find(({ value }) => value.item.event_id === target);
    if (!entry) return;
    handledFocus = target;
    void positionFocus(engine, target, entry.key, !shouldReduceMotion());
  });
  function userScrollMarker(node: HTMLDivElement): () => void {
    return historyController.attach(node);
  }
  function setPersonaOpen(open: boolean): void {
    personaOpen = open;
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
  function markRead(eventId: string): Promise<void> {
    if (windowState.pinned) followingRead = true;
    return onRead(eventId);
  }
  function jumpToLatest(): void {
    focusNavigation?.abort();
    historyController.finishHistoryFill();
    if (!live) {
      onJumpToLive?.();
      return;
    }
    void controller?.jumpTo(null, 'start', !shouldReduceMotion());
  }
</script>

<TimelineReadReceipt {timeline} visibleEventId={readEventId} onRead={markRead} />
<TimelineAnnouncements {timeline} {visibleItems} />
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
  {#if stuckUnreadCount > 0}
    <p class="unread-pinned">
      <span>{$i18n.t('timeline.unreadCount', { count: stuckUnreadCount })}</span>
    </p>
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
        <span class="screen-reader-only">{$i18n.t('timeline.loadingHistory')}</span>
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
        <span class="screen-reader-only">{$i18n.t('timeline.loadingNewer')}</span>
      </div>
    {/if}
    <div class={['timeline-viewport', { initial: !revealed }]}>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        bind:this={viewport}
        class="viewport"
        aria-label={$i18n.t('timeline.label')}
        tabindex="0"
        {@attach mountWindow}
        {@attach userScrollMarker}
        {@attach scrollLock(scrollLocked || personaOpen)}
        role="log"
        aria-live="off"
      >
        <div class={['items', `layout-${preferences.layout}`]}>
          <div class="window-rows">
            {#each rows as row (row.key)}
              {@const { item, collapsed, groupStart } = row.value}
              <div
                class={['item', { collapsed, 'group-start': groupStart }]}
                data-event-id={item.event_id ?? undefined}
                data-item-id={item.id}
                data-index={row.index}
                data-timeline-key={row.key}
              >
                <TimelineItem
                  {item}
                  {collapsed}
                  unreadCount={row.value.unreadCount}
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
                  {encrypted}
                  {members}
                  layout={preferences.layout}
                  alignOwn={preferences.alignOwnMessages}
                  {onJumpToEvent}
                  {onOpenMedia}
                  {onPersonaAvatarClick}
                  {onVotePoll}
                  {onEndPoll}
                  onPersonaOpenChange={setPersonaOpen}
                  {roomId}
                />
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>

    {#if (!revealed || (awaitingContent && rows.length === 0)) && !noHistory}
      <TimelineSkeleton layout={preferences.layout} />
    {:else if visibleItems.length === 0}
      <EmptyState
        class="timeline-empty"
        title={timeline.items.length > 0
          ? $i18n.t('timeline.allFiltered')
          : $i18n.t('timeline.noMessages')}
        description={timeline.items.length > 0 ? $i18n.t('timeline.allFilteredHint') : undefined}
      />
    {/if}
  </div>

  {#if revealed && visibleItems.length > 0 && (live ? jumpToLatestVisible : onJumpToLive !== undefined)}
    <IconButton
      type="button"
      class="jump-to-latest"
      variant="secondary"
      size="medium"
      label={$i18n.t('timeline.jumpToLatest')}
      title={$i18n.t('timeline.jumpToLatest')}
      onclick={jumpToLatest}
    >
      <ArrowDownIcon />
    </IconButton>
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
    --timeline-foot-height: var(--space-600);
    --timeline-indicator-size: var(--target-hit);
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
    --timeline-row-padding: var(--space-050);
  }

  .timeline-content.spacing-roomy {
    --timeline-row-padding: var(--space-200);
  }

  @media (width >= 48rem) and (hover: hover) and (pointer: fine) {
    .timeline-content {
      --line-height-body: 1.47;
    }
  }

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
    overflow: auto;
    overflow-anchor: none;
    overscroll-behavior: contain;
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
  }

  .viewport:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
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
    scrollbar-color: var(--surface-container-line) transparent;
  }

  .viewport:hover::-webkit-scrollbar-thumb,
  .viewport:focus-within::-webkit-scrollbar-thumb {
    background: var(--surface-container-line);
  }

  .items {
    --timeline-media-fill: 100%;
    --timeline-bubble-width: 100%;

    flex: 0 0 auto;
    margin-top: auto;
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
    border-top: calc(var(--border-width) * 2) solid var(--primary-main-line);
    content: '';
    flex: 1;
  }

  .unread-pinned span {
    background: var(--primary-container);
    border: var(--border-width) solid var(--primary-container-line);
    border-radius: var(--radius-pill);
    color: var(--primary-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.04em;
    padding: var(--space-050) var(--space-200);
  }

  .timeline-foot {
    align-items: center;
    background: var(--surface-container);
    display: flex;
    gap: var(--space-200);
    height: var(--timeline-foot-height);
    inset-block-end: 0;
    inset-inline: 0;
    justify-content: space-between;
    padding: 0 var(--page-gutter);
    position: absolute;
    z-index: 1;
  }

  .foot-trailing {
    flex: none;
  }

  :global(button.jump-to-latest) {
    --button-height: var(--timeline-indicator-size);

    background-image: none;
    border-radius: 50%;
    bottom: calc(var(--timeline-foot-height) + var(--space-200));
    box-shadow: var(--shadow-float);
    inset-inline-end: var(--page-gutter);
    position: absolute;
    z-index: 1;
  }
</style>
