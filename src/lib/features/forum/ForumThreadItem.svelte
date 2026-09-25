<script lang="ts">
  import { onDestroy } from 'svelte';

  import DeleteMessageDialog from '#lib/features/room/DeleteMessageDialog.svelte';
  import MessageActions from '#lib/features/room/MessageActions.svelte';
  import MessageActionSheet from '#lib/features/room/MessageActionSheet.svelte';
  import { useMessageMenu } from '#lib/features/room/message-menu-open.svelte.js';
  import { formatMessageTimestamp } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import { LongPress, touchContextMenu } from '#lib/ui/long-press.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import type { ForumThread } from './forum-threads';

  interface Props {
    thread: ForumThread;
    onOpen: (eventId: string) => void;
    canDelete: boolean;
    onEdit: (thread: ForumThread) => void;
    onDelete: (eventId: string, reason: string | null) => void;
    roomId: string;
    onReact: (eventId: string, key: string) => void;
    loadImagePacks: (roomId: string) => Promise<import('#src/generated/protocol').ImagePackView[]>;
    onCopyLink: (eventId: string) => void;
  }

  let {
    thread,
    onOpen,
    canDelete,
    onEdit,
    onDelete,
    roomId,
    onReact,
    loadImagePacks,
    onCopyLink,
  }: Props = $props();
  let deleteOpen = $state(false);
  let sheetOpen = $state(false);

  let displayName = $derived(thread.senderName ?? thread.sender ?? '');
  let replyLabel = $derived(
    thread.replyCount === 1
      ? $i18n.t('forum.replyCount_one', { count: thread.replyCount })
      : $i18n.t('forum.replyCount_other', { count: thread.replyCount })
  );
  let accessibleLabel = $derived(
    thread.unread
      ? $i18n.t('forum.threadUnread', { name: displayName, preview: thread.preview })
      : $i18n.t('forum.thread', { name: displayName, preview: thread.preview })
  );
  let actions = $derived({
    loadImagePacks,
    roomId,
    onReact: (key: string) => onReact(thread.eventId, key),
    onOpenThread: () => onOpen(thread.eventId),
    onEdit: thread.editable ? () => onEdit(thread) : undefined,
    onCopyText:
      thread.preview === '' ? undefined : () => void navigator.clipboard.writeText(thread.preview),
    onCopyLink: () => onCopyLink(thread.eventId),
    onDelete: canDelete ? () => (deleteOpen = true) : undefined,
  });
  const openMessageMenu = useMessageMenu();
  const rowPress = new LongPress({
    enabled: () => true,
    onPress: () => {
      sheetOpen = true;
    },
  });

  function openContextMenu(event: MouseEvent): void {
    if (rowPress.touch || touchContextMenu(event)) {
      event.preventDefault();
      if (!rowPress.pending && !sheetOpen) rowPress.fire(event);
      return;
    }
    event.preventDefault();
    openMessageMenu.open(thread.id, { x: event.clientX, y: event.clientY }, () => actions);
  }

  onDestroy(() => {
    rowPress.cancel();
  });
</script>

<li class="forum-thread-item">
  <article
    class:pressed={rowPress.pressing}
    class="forum-thread-card"
    onpointerdown={rowPress.start}
    onpointermove={rowPress.move}
    onpointerup={rowPress.end}
    onpointercancel={rowPress.end}
    oncontextmenu={openContextMenu}
  >
    <button
      type="button"
      class="forum-thread-button"
      aria-label={accessibleLabel}
      onclick={() => onOpen(thread.eventId)}
    >
      <Avatar
        class="forum-thread-avatar"
        id={thread.sender}
        src={thread.senderAvatar}
        name={displayName}
        size="medium"
      />
      <span class="forum-thread-body">
        <span class="forum-thread-top">
          <span class="forum-thread-sender">{displayName}</span>
          <span class="forum-thread-time">{formatMessageTimestamp(thread.lastActivityAt)}</span>
        </span>
        <span class="forum-thread-preview">{thread.preview}</span>
        <span class="forum-thread-meta">
          <span class="forum-thread-replies">{replyLabel}</span>
          {#if thread.lastBody}
            <span class="forum-thread-last">
              {thread.lastSenderName ?? displayName}: {thread.lastBody}
            </span>
          {/if}
        </span>
      </span>
      {#if thread.unread}
        <span class="forum-thread-unread-dot" aria-hidden="true"></span>
      {/if}
    </button>
    <MessageActions {...actions} />
  </article>
</li>

<DeleteMessageDialog
  bind:open={deleteOpen}
  preview={thread.preview}
  title={$i18n.t('forum.deleteThreadTitle')}
  description={$i18n.t('forum.deleteThreadExplain')}
  confirmLabel={$i18n.t('forum.deleteThread')}
  onConfirm={(reason) => onDelete(thread.eventId, reason)}
/>

<MessageActionSheet bind:open={sheetOpen} preview={thread.preview} {...actions} />

<style>
  .forum-thread-item {
    list-style: none;
    margin-top: var(--space-300);
  }

  .forum-thread-button {
    align-items: center;
    background: var(--surface-var-container);
    border: 0;
    border-radius: var(--radii-400);
    box-sizing: border-box;
    cursor: pointer;
    display: flex;
    gap: var(--space-300);
    padding: var(--space-400);
    text-align: left;
    width: 100%;
  }

  .forum-thread-card {
    align-items: center;
    background: var(--surface-var-container);
    border-radius: var(--radii-400);
    display: flex;
    position: relative;
  }

  .forum-thread-card:has(.forum-thread-button:hover),
  .forum-thread-card:has(.forum-thread-button:focus-visible) {
    background: var(--surface-container-hover);
  }

  @media (hover: hover) and (pointer: fine) {
    .forum-thread-card:hover :global(.message-actions),
    .forum-thread-card:focus-within :global(.message-actions) {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .forum-thread-card.pressed {
    background: var(--surface-container-hover);
  }

  .forum-thread-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-200);
    min-width: 0;
  }

  .forum-thread-top {
    align-items: baseline;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  .forum-thread-sender {
    font-weight: var(--font-weight-500);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-time {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
  }

  .forum-thread-preview {
    color: var(--bg-on-container);
    font-weight: var(--font-weight-500);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-meta {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    overflow: hidden;
  }

  .forum-thread-replies {
    background: var(--surface-container);
    border-radius: var(--radius-pill);
    flex: 0 0 auto;
    padding: var(--space-050) var(--space-200);
  }

  .forum-thread-last {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-unread-dot {
    background: var(--primary-main);
    border-radius: 50%;
    flex: 0 0 auto;
    height: 0.5rem;
    width: 0.5rem;
  }
</style>
