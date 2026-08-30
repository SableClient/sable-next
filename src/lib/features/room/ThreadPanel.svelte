<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import { onDestroy, untrack } from 'svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import RoomComposer from '#lib/features/composer/RoomComposer.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { Conversation } from './conversation.svelte.js';
  import TimelineList from './TimelineList.svelte';

  interface Props {
    roomId: string;
    rootEventId: string;
    roomName?: string | null;
    members?: readonly MemberView[];
    readOnly?: boolean;
    canRedactOthers?: boolean;
    modal?: boolean;
    onClose: () => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    onCopyLink?: (eventId: string) => void;
    onOpenMedia?: (eventId: string) => void;
  }

  let {
    roomId,
    rootEventId,
    roomName = null,
    members = [],
    readOnly = false,
    canRedactOthers = false,
    modal = false,
    onClose,
    onSenderProfile,
    onCopyLink,
    onOpenMedia,
  }: Props = $props();

  const core = useCoreClient();
  const personas = usePersonaStore();
  const timeline = new RoomTimeline(core);
  const conversation = new Conversation({
    core,
    personas,
    timeline,
    roomId: () => roomId,
    threadRoot: untrack(() => rootEventId),
  });

  $effect(() => {
    void timeline.startThread(roomId, rootEventId);
  });

  $effect(() => {
    conversation.fetchMissingReplyDetails();
  });

  onDestroy(() => {
    void timeline.stop();
  });

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  function markRead(): Promise<void> {
    return Promise.resolve();
  }
</script>

<aside class="thread-panel" class:modal aria-label={$i18n.t('timeline.thread')}>
  <header class="thread-header">
    <h2>{$i18n.t('timeline.thread')}</h2>
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
    {timeline}
    {roomId}
    {members}
    {readOnly}
    {canRedactOthers}
    {onSenderProfile}
    {onCopyLink}
    {onOpenMedia}
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

  <div class="thread-composer">
    <RoomComposer
      {roomId}
      threadRoot={rootEventId}
      {roomName}
      {readOnly}
      onSend={conversation.sendMessage}
      onSendAttachment={conversation.sendAttachment}
      onSendSticker={conversation.sendSticker}
      onSendGif={conversation.sendGif}
      onCreatePoll={conversation.createPoll}
      onSendLocation={conversation.sendLocation}
      onTyping={conversation.setTyping}
      context={conversation.context}
      onCancelContext={conversation.clearContext}
      onEditLast={conversation.editLast}
    />
  </div>
</aside>

<style>
  .thread-panel {
    background: var(--sable-surface-container);
    border-left: var(--border-width) solid var(--sable-surface-container-line);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-height: 0;
    width: 22rem;
  }

  .thread-panel.modal {
    border-left: none;
    width: 100%;
  }

  .thread-header {
    align-items: center;
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    padding: var(--space-300) var(--space-400);
  }

  .thread-header h2 {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .thread-composer {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    padding: var(--space-300);
  }
</style>
