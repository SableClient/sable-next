<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';
  import { onDestroy, onMount, untrack } from 'svelte';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import {
    finishSwipeGesture,
    startSwipeGesture,
    updateSwipeGesture,
    type SwipeGesture,
  } from '#lib/ui/swipe-gesture.js';

  import ConversationComposer from './ConversationComposer.svelte';
  import { Conversation } from './conversation.svelte.js';
  import { timelineMediaItems } from './media-items.js';
  import MediaViewer from './MediaViewer.svelte';
  import TimelineList from './TimelineList.svelte';
  import {
    clampThreadPanelWidth,
    MAX_THREAD_PANEL_WIDTH,
    MIN_THREAD_PANEL_WIDTH,
    remFromPointerDelta,
    THREAD_PANEL_WIDTH_STEP,
  } from './thread-panel-width.js';

  const WIDTH_STORAGE_KEY = 'sable-thread-panel-width';

  interface Props {
    roomId: string;
    rootEventId: string;
    roomName?: string | null;
    members?: readonly MemberView[];
    readOnly?: boolean;
    canRedactOwn?: boolean;
    canRedactOthers?: boolean;
    encrypted?: boolean | null;
    modal?: boolean;
    onClose: () => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onCopyLink?: (eventId: string) => void;
    onPersonaAvatarClick?: (source: string, displayName: string) => void;
  }

  let {
    roomId,
    rootEventId,
    roomName = null,
    members = [],
    readOnly = false,
    canRedactOwn = true,
    canRedactOthers = false,
    encrypted = null,
    modal = false,
    onClose,
    onSenderProfile,
    onCopyLink,
    onPersonaAvatarClick,
  }: Props = $props();

  let composer = $state<ConversationComposer>();
  let timelineList = $state<TimelineList>();
  let width = $state(27.5);
  let panel = $state<HTMLElement>();
  let swipe: SwipeGesture | undefined;
  let swipeOffset = $state(0);
  let swiping = $state(false);
  let mediaEventId = $state<string | null>(null);

  const core = useCoreClient();
  const personas = usePersonaStore();
  const timeline = new RoomTimeline(core);
  const conversation = new Conversation({
    core,
    personas,
    timeline,
    roomId: () => roomId,
    encrypted: () => encrypted,
    threadRoot: untrack(() => rootEventId),
  });

  $effect(() => {
    void timeline.startThread(roomId, rootEventId);
  });

  $effect(() => {
    conversation.fetchMissingReplyDetails();
  });

  onMount(() => {
    const stored = Number.parseFloat(localStorage.getItem(WIDTH_STORAGE_KEY) ?? '');
    if (Number.isFinite(stored)) width = clampThreadPanelWidth(stored);
  });

  onDestroy(() => {
    void timeline.stop();
  });

  function remFromPixels(pixels: number): number {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return remFromPointerDelta(pixels, rootFontSize);
  }

  function startSwipe(event: TouchEvent): void {
    swipe = startSwipeGesture(event, 0);
  }

  function moveSwipe(event: TouchEvent): void {
    if (!swipe) return;
    const update = updateSwipeGesture(swipe, event);
    if (!update || update.mode !== 'horizontal') return;
    swiping = true;
    swipeOffset = Math.max(0, update.distanceX);
  }

  function finishSwipe(cancelled: boolean): void {
    const active = swipe;
    swipe = undefined;
    swiping = false;
    if (!active) return;
    const offset = swipeOffset;
    swipeOffset = 0;
    const result = finishSwipeGesture(active, offset, cancelled);
    if (!result.handled) return;
    const width = panel?.clientWidth ?? 0;
    if (result.direction === 'right' || (result.direction === undefined && offset > width / 2)) {
      onClose();
    }
  }

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  function markRead(eventId: string): Promise<void> {
    return core.commands.markRead(
      roomId,
      eventId,
      readReceiptIsPrivate(),
      rootEventId,
      timeline.subscriptionId
    );
  }
</script>

{#if modal}
  <DialogFrame
    open
    onOpenChange={(open: boolean) => {
      if (!open) onClose();
    }}
    variant="fullscreen"
    contentClass={swiping ? 'thread-screen swiping' : 'thread-screen'}
    contentStyle={swipeOffset > 0 ? `transform: translateX(${String(swipeOffset)}px)` : undefined}
  >
    {@render body()}
  </DialogFrame>
{:else}
  {@render body()}
{/if}

{#snippet body()}
  <aside
    bind:this={panel}
    class="thread-panel"
    class:modal
    style:width={modal ? null : `${width}rem`}
    aria-label={$i18n.t('timeline.thread')}
    ontouchstart={modal ? startSwipe : undefined}
    ontouchmove={modal ? moveSwipe : undefined}
    ontouchend={modal ? () => finishSwipe(false) : undefined}
    ontouchcancel={modal ? () => finishSwipe(true) : undefined}
  >
    {#if !modal}
      <ResizeHandle
        value={width}
        min={MIN_THREAD_PANEL_WIDTH}
        max={MAX_THREAD_PANEL_WIDTH}
        label={$i18n.t('timeline.thread')}
        grow="left"
        step={THREAD_PANEL_WIDTH_STEP}
        fromPixels={remFromPixels}
        onResize={(next) => (width = clampThreadPanelWidth(next))}
        onCommit={() => localStorage.setItem(WIDTH_STORAGE_KEY, String(width))}
      />
    {/if}
    <PanelHeader class="thread-header" title={$i18n.t('timeline.thread')}>
      {#snippet prefix()}
        <ChatsIcon aria-hidden="true" />
      {/snippet}
      {#snippet suffix()}
        <PanelHeaderButton label={$i18n.t('timeline.threadClose')} onclick={onClose}>
          <XIcon />
        </PanelHeaderButton>
      {/snippet}
    </PanelHeader>

    <TimelineList
      bind:this={timelineList}
      replyEventId={conversation.context?.kind === 'reply' ? conversation.context.eventId : null}
      {timeline}
      {roomId}
      {members}
      {readOnly}
      {canRedactOwn}
      {canRedactOthers}
      {encrypted}
      {onSenderProfile}
      onMentionUser={(userId, name) => composer?.insertMention(userId, name)}
      {onCopyLink}
      onOpenMedia={(eventId) => (mediaEventId = eventId)}
      {onPersonaAvatarClick}
      onRequestHistory={requestHistory}
      onRequestFuture={requestFuture}
      onRead={markRead}
      onReply={conversation.reply}
      onEdit={conversation.edit}
      onDelete={conversation.redact}
      onToggleReaction={conversation.toggleReaction}
      onVotePoll={conversation.votePoll}
      onEndPoll={conversation.endPoll}
      onRetrySend={conversation.retrySend}
      onCancelSend={conversation.cancelSend}
      currentUserId={core.session?.user_id ?? null}
    />

    <div class="thread-composer" onfocusin={(event) => timelineList?.composerFocused(event)}>
      <ConversationComposer
        bind:this={composer}
        {conversation}
        {roomId}
        threadRoot={rootEventId}
        {roomName}
        {readOnly}
        onDeleteEdited={conversation.redact}
        onEditLast={conversation.editLast}
        onReplyStep={(direction) =>
          conversation.moveReply(timelineList?.stepReply(direction) ?? null)}
      />
    </div>
  </aside>
  {#if mediaEventId}
    <MediaViewer
      items={timelineMediaItems(timeline.items)}
      selectedEventId={mediaEventId}
      onClose={() => (mediaEventId = null)}
    />
  {/if}
{/snippet}

<style>
  .thread-panel {
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    border-left: var(--border-width) solid var(--bg-container-line);
    display: grid;
    flex: 0 0 auto;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .thread-panel.modal {
    background-color: var(--bg-container);
    border-left: none;
    height: 100%;
    touch-action: pan-y;
    width: 100%;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on']) .thread-screen:not(.swiping)) {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .thread-panel :global(.resize-handle) {
    left: -0.25rem;
    z-index: 1;
  }

  .thread-composer {
    min-width: 0;
    padding-bottom: max(var(--space-200), var(--edge-inset-bottom));
  }

  @media (width >= 48rem) {
    .thread-composer {
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: center;
      margin-block-start: calc(-1 * var(--space-300));
      min-height: var(--sidebar-footer-height);
      padding-block: var(--space-300);
    }
  }
</style>
