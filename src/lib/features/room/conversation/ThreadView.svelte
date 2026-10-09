<script lang="ts">
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';

  import { page } from '$app/state';
  import { useCoreClient } from '#lib/core/context.js';
  import { personaSpaces } from '#lib/features/composer/persona-spaces.js';
  import { readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import { SwipeBack } from '#lib/ui/swipe-back.svelte.js';

  import ConversationComposer from './ConversationComposer.svelte';
  import { Conversation } from './conversation.svelte.js';
  import { timelineMediaItems } from '../media/media-items.js';
  import MediaViewer from '../media/MediaViewer.svelte';
  import { replyPreviewBody } from '../messages/reply-preview.js';
  import TimelineList from '../timeline/TimelineList.svelte';
  import {
    clampThreadPanelWidth,
    MIN_THREAD_PANEL_WIDTH,
    MAX_THREAD_PANEL_WIDTH,
    THREAD_PANEL_WIDTH_STEP,
    remFromPointerDelta,
  } from './thread-panel-width.js';

  interface Props {
    roomId: string;
    rootEventId: string;
    focusEventId?: string | null;
    roomName?: string | null;
    rootMessage?: TimelineItemView | null;
    sidePanel?: boolean;
    backLabel?: string;
    members?: readonly MemberView[];
    readOnly?: boolean;
    canRedactOwn?: boolean;
    canRedactOthers?: boolean;
    canReact?: boolean;
    canPin?: boolean;
    encrypted?: boolean | null;
    onClose: () => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onCopyLink?: (eventId: string) => void;
  }

  let {
    roomId,
    rootEventId,
    focusEventId = null,
    roomName = null,
    rootMessage = null,
    sidePanel = false,
    backLabel,
    members = [],
    readOnly = false,
    canRedactOwn = true,
    canRedactOthers = false,
    canReact = true,
    canPin = true,
    encrypted = null,
    onClose,
    onSenderProfile,
    onCopyLink,
  }: Props = $props();

  let composer = $state<ConversationComposer>();
  let timelineList = $state<TimelineList>();
  let panel = $state<HTMLElement>();
  let width = $state(27.5);
  const widthStorageKey = 'sable-thread-panel-width';
  const swipe = new SwipeBack({
    width: () => panel?.clientWidth ?? 0,
    onDismiss: () => onClose(),
  });
  let mediaEventId = $state<string | null>(null);

  const core = useCoreClient();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const timeline = new RoomTimeline(core);
  const conversation = new Conversation({
    core,
    personas,
    timeline,
    roomId: () => roomId,
    spaceIds: (id) => personaSpaces(roomList.rooms, id, page.params.spaceId).order,
    encrypted: () => encrypted,
    threadRoot: untrack(() => rootEventId),
  });

  $effect(() => {
    const target = focusEventId;
    if (target === null) {
      void timeline.startThread(roomId, rootEventId);
      return;
    }
    const navigation = new AbortController();
    void (async () => {
      await timeline.startThread(roomId, rootEventId);
      await timeline.loadThreadEvent(target, navigation.signal);
    })().catch((error: unknown) => {
      console.debug('[sable thread] linked reply unavailable', error);
    });
    return () => {
      navigation.abort();
    };
  });

  $effect(() => {
    conversation.fetchMissingReplyDetails();
  });

  onMount(() => {
    const stored = Number.parseFloat(localStorage.getItem(widthStorageKey) ?? '');
    if (Number.isFinite(stored)) width = clampThreadPanelWidth(stored);
    const previousFocus = document.activeElement;
    panel?.focus({ preventScroll: true });
    return () => {
      void tick().then(() => {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  });

  onDestroy(() => {
    swipe.reset();
    void timeline.stop();
  });

  let original = $derived(
    timeline.items.find((item) => item.event_id === rootEventId) ?? rootMessage
  );
  let topic = $derived(
    original ? replyPreviewBody(original.content).replace(/\s+/g, ' ').trim() : ''
  );

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

<svelte:window
  onkeydown={(event) => {
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      event.target instanceof Node &&
      panel?.contains(event.target)
    ) {
      event.preventDefault();
      onClose();
    }
  }}
/>

<section
  bind:this={panel}
  class="thread-view"
  class:side-panel={sidePanel}
  style:width={sidePanel ? `${width}rem` : undefined}
  class:swiping={swipe.swiping}
  style:transform={swipe.transform}
  aria-label={$i18n.t('timeline.thread')}
  tabindex="-1"
  ontouchstart={swipe.start}
  ontouchmove={swipe.move}
  ontouchend={() => swipe.finish(false)}
  ontouchcancel={() => swipe.finish(true)}
>
  <PanelHeader
    class="thread-header"
    title={topic || $i18n.t('timeline.thread')}
    titleSize="h1"
    subtitle={roomName ?? ''}
  >
    {#snippet prefix()}
      <PanelHeaderButton
        label={sidePanel
          ? $i18n.t('timeline.threadClose')
          : (backLabel ?? $i18n.t('timeline.backToConversation'))}
        onclick={onClose}
      >
        {#if sidePanel}<XIcon />{:else}<BackIcon />{/if}
      </PanelHeaderButton>
    {/snippet}
    {#snippet suffix()}
      {#if timeline.items.some((item) => item.event_id === rootEventId)}
        <PanelHeaderButton
          label={$i18n.t('timeline.jumpToOriginal')}
          onclick={() => timelineList?.jumpToEvent(rootEventId)}
        >
          <ArrowUpIcon />
        </PanelHeaderButton>
      {/if}
    {/snippet}
  </PanelHeader>

  {#if sidePanel}
    <ResizeHandle
      value={width}
      min={MIN_THREAD_PANEL_WIDTH}
      max={MAX_THREAD_PANEL_WIDTH}
      step={THREAD_PANEL_WIDTH_STEP}
      label={$i18n.t('timeline.resizeThread')}
      grow="left"
      fromPixels={(pixels) =>
        remFromPointerDelta(
          pixels,
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        )}
      onResize={(next) => (width = clampThreadPanelWidth(next))}
      onCommit={() => localStorage.setItem(widthStorageKey, String(width))}
    />
  {/if}

  <TimelineList
    bind:this={timelineList}
    replyEventId={conversation.context?.kind === 'reply' ? conversation.context.eventId : null}
    {timeline}
    {focusEventId}
    threadRootId={rootEventId}
    onRetryLoad={() => timeline.startThread(roomId, rootEventId)}
    {roomId}
    {members}
    {readOnly}
    {canRedactOwn}
    {canRedactOthers}
    {canPin}
    {encrypted}
    {onSenderProfile}
    onMentionUser={(userId, name) => composer?.insertMention(userId, name)}
    {onCopyLink}
    onOpenMedia={(eventId) => (mediaEventId = eventId)}
    onRequestHistory={requestHistory}
    onRequestFuture={requestFuture}
    onRead={markRead}
    onReply={readOnly ? undefined : conversation.reply}
    onEdit={readOnly ? undefined : conversation.edit}
    onDelete={conversation.redact}
    onToggleReaction={canReact ? conversation.toggleReaction : undefined}
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
      {canReact}
      onDeleteEdited={conversation.redact}
      onEditLast={conversation.editLast}
      onEditNext={conversation.editNext}
      onReplyStep={(direction) =>
        conversation.moveReply(timelineList?.stepReply(direction) ?? null)}
    />
  </div>
</section>
{#if mediaEventId}
  <MediaViewer
    items={timelineMediaItems(timeline.items)}
    selectedEventId={mediaEventId}
    onClose={() => (mediaEventId = null)}
  />
{/if}

<style>
  .thread-view {
    --ghost-hover: var(--surface-container-hover);
    --ghost-active: var(--surface-container-active);

    background: var(--surface-container);
    color: var(--surface-on-container);
    display: flex;
    flex: 1;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
    outline: none;
    position: relative;
    touch-action: pan-y;
  }

  .thread-view.side-panel {
    border-inline-start: var(--border-width) solid var(--surface-container-line);
    flex: 0 1 auto;
    max-width: calc(100% - var(--room-column-min-width));
    min-width: var(--side-panel-min-width);
  }

  .thread-view :global(.resize-handle) {
    inset-inline-start: calc(-1 * var(--space-050));
    z-index: 1;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .thread-view:not(.swiping) {
      transition: transform var(--duration-medium) var(--ease-slide);
    }
  }

  .thread-composer {
    flex: 0 0 auto;
    min-width: 0;
    padding-bottom: max(var(--space-200), var(--edge-inset-bottom));
  }

  @media (width >= 48rem) {
    .thread-composer {
      --composer-band: calc(var(--sidebar-footer-height) - 2 * var(--space-300));

      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      margin-block-start: calc(-1 * var(--space-300));
      min-height: var(--sidebar-footer-height);
      padding-block: var(--space-300);
    }
  }
</style>
