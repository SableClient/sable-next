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
  import RoomComposer from '#lib/features/composer/RoomComposer.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import {
    finishSwipeGesture,
    startSwipeGesture,
    updateSwipeGesture,
    type SwipeGesture,
  } from '#lib/ui/swipe-gesture.js';

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
    canRedactOthers = false,
    encrypted = null,
    modal = false,
    onClose,
    onSenderProfile,
    onCopyLink,
    onPersonaAvatarClick,
  }: Props = $props();

  let composer = $state<RoomComposer>();
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
    <header class="thread-header">
      <div class="thread-title">
        <ChatsIcon aria-hidden="true" />
        <h2>{$i18n.t('timeline.thread')}</h2>
      </div>
      <IconButton
        variant="ghost"
        size="small"
        label={$i18n.t('timeline.threadClose')}
        onclick={onClose}
      >
        <XIcon />
      </IconButton>
    </header>

    <TimelineList
      bind:this={timelineList}
      {timeline}
      {roomId}
      {members}
      {readOnly}
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
      <RoomComposer
        bind:this={composer}
        {roomId}
        threadRoot={rootEventId}
        {roomName}
        {readOnly}
        onSend={conversation.sendMessage}
        onSendAttachment={conversation.sendAttachment}
        onSendGallery={conversation.sendGallery}
        onSendSticker={conversation.sendSticker}
        onSendGif={conversation.sendGif}
        onCreatePoll={conversation.createPoll}
        onSendLocation={conversation.sendLocation}
        onTyping={conversation.setTyping}
        context={conversation.context}
        onCancelContext={conversation.clearContext}
        onToggleSilentReply={conversation.toggleSilentReply}
        onDeleteEdited={conversation.redact}
        onEditLast={conversation.editLast}
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
    background: var(--surface-container);
    border-left: var(--border-width) solid var(--surface-container-line);
    display: grid;
    flex: 0 0 auto;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .thread-panel.modal {
    background-color: var(--bg-container);
    background-image: linear-gradient(var(--surface-container), var(--surface-container));
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

  .thread-header {
    align-items: center;
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    min-height: 3.5rem;
    padding: 0 var(--space-200) 0 var(--space-400);
  }

  .thread-title {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
  }

  .thread-header h2 {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .thread-composer {
    border-top: var(--border-width) solid var(--surface-container-line);
    min-width: 0;
    padding: 0 var(--space-400);
  }
</style>
