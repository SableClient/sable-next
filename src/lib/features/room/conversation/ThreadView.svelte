<script lang="ts">
  import { panelIn, panelOut, usePanelStage } from '#lib/ui/motion.js';
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';

  import { page } from '$app/state';
  import { readText, writeText } from '#lib/platform/local-json.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { personaSpaces } from '#lib/features/composer/persona-spaces.js';
  import { i18n } from '#lib/i18n.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import { useThreadSidebar } from '#lib/features/sidebar/thread-sidebar.svelte.js';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import { SwipeBack } from '#lib/ui/swipe-back.svelte.js';

  import ConversationComposer from './ConversationComposer.svelte';
  import InlineEdit from './InlineEdit.svelte';
  import { Conversation } from './conversation.svelte.js';
  import { donateSentMessage } from '#lib/features/share/donate-sent-message.js';
  import { timelineMediaItems } from '#lib/ui/media/media-items.js';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';
  import { replyPreviewBody } from '../messages/reply-preview.js';
  import TimelineList from '../timeline/TimelineList.svelte';
  import ThreadSidebarActions from './ThreadSidebarActions.svelte';
  import type { TimelineCallbacks } from '../timeline/timeline-row.svelte.js';
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
    onRead?: (rootId: string, item: TimelineItemView) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
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
    onRead,
    onSenderProfile,
    onMatrixLink,
    onCopyLink,
  }: Props = $props();
  const stage = usePanelStage();

  let composer = $state<ConversationComposer>();
  let timelineList = $state<TimelineList>();
  let panel = $state<HTMLElement>();
  const widthStorageKey = 'sable-thread-panel-width';
  const storedWidth = Number.parseFloat(readText(widthStorageKey) ?? '');
  let width = $state(Number.isFinite(storedWidth) ? clampThreadPanelWidth(storedWidth) : 27.5);
  const swipe = new SwipeBack({
    width: () => panel?.clientWidth ?? 0,
    onDismiss: () => onClose(),
  });

  const core = useCoreClient();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const threadSidebar = useThreadSidebar();
  const timeline = new RoomTimeline(core);
  const conversation = new Conversation({
    core,
    personas,
    timeline,
    roomId: () => roomId,
    spaceIds: (id) => personaSpaces(roomList, id, page.params.spaceId).order,
    encrypted: () => encrypted,
    publicRoom: () => roomList.byId(roomId)?.join_rule === 'public',
    threadRoot: untrack(() => rootEventId),
    canRedactOwn: () => canRedactOwn,
    beforeSend: () => returnToThread(),
    afterSend: (id) => {
      donateSentMessage(core, roomList.byId(id));
      threadSidebar?.noteReply(id, rootEventId, original);
    },
  });

  function returnToThread(): Promise<void> {
    return timeline.mode.kind === 'focused'
      ? timeline.startThread(roomId, rootEventId)
      : Promise.resolve();
  }

  function jumpToEvent(eventId: string): void {
    if (!timelineList?.jumpToEvent(eventId)) {
      focusEventId = eventId;
    }
  }

  $effect(() => {
    const target = focusEventId;
    // The root's own context is the room around it, which takes no thread actions.
    if (target === null || target === rootEventId) {
      void timeline.startThread(roomId, rootEventId);
      return;
    }
    const navigation = new AbortController();
    void (async () => {
      await timeline.startThread(roomId, rootEventId);
      if (navigation.signal.aborted || timeline.items.some((item) => item.event_id === target))
        return;
      await timeline.start(roomId, target);
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

  /** The list holds its place for a focus it cannot find, so it gets the root once that has loaded. */
  let listFocus = $derived(
    focusEventId === rootEventId && !timeline.items.some((item) => item.event_id === rootEventId)
      ? null
      : focusEventId
  );
  let original = $derived(
    timeline.items.find((item) => item.event_id === rootEventId) ?? rootMessage
  );
  let topic = $derived(
    original
      ? (original.forum_title ?? replyPreviewBody(original.content).replace(/\s+/g, ' ').trim())
      : ''
  );

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  async function markRead(eventId: string): Promise<void> {
    const expectedReplies =
      original?.thread_summary?.num_replies ?? rootMessage?.thread_summary?.num_replies ?? 0;
    if (
      eventId === rootEventId &&
      expectedReplies > 0 &&
      timeline.backwardPagination !== 'end' &&
      !timeline.items.some((entry) => entry.event_id !== null && entry.event_id !== rootEventId)
    ) {
      return;
    }
    const item = timeline.items.find((entry) => entry.event_id === eventId);
    if (item) onRead?.(rootEventId, item);
    await core.rpc.timeline.markRead({
      room_id: roomId,
      event_id: eventId,
      thread_root: rootEventId,
      subscription: timeline.subscriptionId,
      fully_read: false,
    });
  }
  const timelineCallbacks: TimelineCallbacks = {
    get onSenderProfile() {
      return onSenderProfile;
    },
    get onMatrixLink() {
      return onMatrixLink;
    },
    onMentionUser: (userId, name) => composer?.insertMention(userId, name),
    get onCopyLink() {
      return onCopyLink;
    },
    onOpenMedia: (eventId) =>
      mediaViewerState.openPanel(timelineMediaItems(timeline.items), eventId, (target) => {
        timelineList?.jumpToEvent(target);
      }),
    get onReply() {
      return readOnly ? undefined : conversation.reply;
    },
    onCancelContext: conversation.clearContext,
    get onEdit() {
      return readOnly ? undefined : conversation.edit;
    },
    onDelete: conversation.redact,
    get onToggleReaction() {
      return canReact ? conversation.toggleReaction : undefined;
    },
    onVotePoll: conversation.votePoll,
    onEndPoll: conversation.endPoll,
    onRetrySend: conversation.retrySend,
    onCancelSend: conversation.cancelSend,
  };
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
  in:panelIn|global={{ cover: !sidePanel, stage }}
  out:panelOut|global={{ cover: !sidePanel, stage }}
  class={['thread-view', { 'side-panel': sidePanel, swiping: swipe.swiping }]}
  style:width={sidePanel ? `${width}rem` : undefined}
  style:transform={swipe.transform}
  aria-label={i18n.t('timeline.thread')}
  tabindex="-1"
  ontouchstart={swipe.start}
  ontouchmove={swipe.move}
  ontouchend={() => swipe.finish(false)}
  ontouchcancel={() => swipe.finish(true)}
>
  {#snippet backButton()}
    <PanelHeaderButton label={backLabel ?? i18n.t('timeline.backToConversation')} onclick={onClose}>
      <BackIcon class="mirror-rtl" />
    </PanelHeaderButton>
  {/snippet}

  <PanelHeader
    class="thread-header"
    title={topic || i18n.t('timeline.thread')}
    titleSize="h1"
    subtitle={roomName ?? ''}
    prefix={sidePanel ? undefined : backButton}
  >
    {#snippet suffix()}
      {#if timeline.items.some((item) => item.event_id === rootEventId)}
        <PanelHeaderButton
          label={i18n.t('timeline.jumpToOriginal')}
          onclick={() => timelineList?.jumpToEvent(rootEventId)}
        >
          <ArrowUpIcon />
        </PanelHeaderButton>
      {/if}
      <ThreadSidebarActions {roomId} rootId={rootEventId} root={original} />
      {#if sidePanel}
        <PanelHeaderButton label={i18n.t('timeline.threadClose')} onclick={onClose}>
          <XIcon />
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
      label={i18n.t('timeline.resizeThread')}
      grow="left"
      fromPixels={(pixels) =>
        remFromPointerDelta(
          pixels,
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        )}
      onResize={(next) => (width = clampThreadPanelWidth(next))}
      onCommit={() => writeText(widthStorageKey, String(width))}
    />
  {/if}

  {#snippet inlineEditor()}
    <InlineEdit {conversation} {roomId} />
  {/snippet}

  <TimelineList
    bind:this={timelineList}
    replyEventId={conversation.context?.kind === 'reply' ? conversation.context.eventId : null}
    editEventId={conversation.context?.kind === 'edit' ? conversation.context.eventId : null}
    inlineEditor={conversation.inlineEdit ? inlineEditor : undefined}
    {timeline}
    focusEventId={listFocus}
    threadRootId={rootEventId}
    onRetryLoad={() => timeline.retry()}
    onJumpToEvent={jumpToEvent}
    onJumpToLive={timeline.mode.kind === 'focused' ? () => void returnToThread() : undefined}
    {roomId}
    {members}
    {readOnly}
    {canRedactOwn}
    {canRedactOthers}
    {canPin}
    {encrypted}
    callbacks={timelineCallbacks}
    onRequestHistory={requestHistory}
    onRequestFuture={requestFuture}
    onRead={markRead}
    currentUserId={core.session?.user_id ?? null}
  />

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="thread-composer"
    onfocusin={(event) => timelineList?.composerFocused(event)}
    onkeydown={(event) => timelineList?.composerKeydown(event)}
  >
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

  @media (--app-layout) {
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
