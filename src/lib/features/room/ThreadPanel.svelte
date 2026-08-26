<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import { onDestroy } from 'svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import type { OutgoingMentions } from '#lib/core/client.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import RoomComposer from '#lib/features/composer/RoomComposer.svelte';

  import TimelineList from './TimelineList.svelte';

  interface Props {
    roomId: string;
    rootEventId: string;
    members?: readonly MemberView[];
    readOnly?: boolean;
    canRedactOthers?: boolean;
    modal?: boolean;
    onClose: () => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    roomId,
    rootEventId,
    members = [],
    readOnly = false,
    canRedactOthers = false,
    modal = false,
    onClose,
    onSenderProfile,
  }: Props = $props();

  const core = useCoreClient();
  const timeline = new RoomTimeline(core);
  let replyTo = $state<string | null>(null);

  $effect(() => {
    void timeline.startThread(roomId, rootEventId);
  });

  onDestroy(() => {
    void timeline.stop();
  });

  async function send(
    _targetRoomId: string,
    body: string,
    formatted: string | null,
    mentions: OutgoingMentions
  ): Promise<void> {
    if (body === '') return;

    await core.commands.sendMessage(roomId, body, {
      formatted,
      mentions,
      threadRoot: rootEventId,
      inReplyTo: replyTo,
    });
    replyTo = null;
  }

  async function sendAttachment(
    _targetRoomId: string,
    file: File,
    options: { caption?: string } = {}
  ): Promise<void> {
    await core.commands.sendAttachment(roomId, file, {
      caption: options.caption,
      threadRoot: rootEventId,
      inReplyTo: replyTo,
    });
    replyTo = null;
  }

  function setTyping(_targetRoomId: string, typing: boolean): Promise<void> {
    return core.commands.setTyping(roomId, typing);
  }

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  function markRead(): Promise<void> {
    return Promise.resolve();
  }

  function onToggleReaction(eventId: string, key: string): void {
    void core.commands.toggleReaction(roomId, eventId, key);
  }

  function onDelete(eventId: string, reason: string | null): void {
    void core.commands.redact(roomId, eventId, reason);
  }

  function onEdit(eventId: string, body: string, html: string | null): void {
    void core.commands.editMessage(roomId, eventId, body, { formatted: html });
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
    onRequestHistory={requestHistory}
    onRequestFuture={requestFuture}
    onRead={markRead}
    {onSenderProfile}
    onReply={(eventId) => (replyTo = eventId)}
    {onToggleReaction}
    {onDelete}
    {onEdit}
    currentUserId={core.session?.user_id ?? null}
  />

  <div class="thread-composer">
    <RoomComposer
      {roomId}
      onSend={send}
      onSendAttachment={sendAttachment}
      onTyping={setTyping}
      {readOnly}
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
    gap: var(--space-2);
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
  }

  .thread-header h2 {
    font-size: var(--font-size-large);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .thread-composer {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    padding: var(--space-2);
  }
</style>
