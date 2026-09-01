<script lang="ts">
  import { formatMessageTimestamp } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import type { ForumThread } from './forum-threads';

  interface Props {
    thread: ForumThread;
    onOpen: (eventId: string) => void;
  }

  let { thread, onOpen }: Props = $props();

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
</script>

<li class="forum-thread-item">
  <button
    type="button"
    class="forum-thread-button"
    aria-label={accessibleLabel}
    onclick={() => onOpen(thread.eventId)}
  >
    <Avatar
      class="forum-thread-avatar"
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
</li>

<style>
  .forum-thread-item {
    list-style: none;
  }

  .forum-thread-button {
    align-items: center;
    background: none;
    border: none;
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    box-sizing: border-box;
    cursor: pointer;
    display: flex;
    gap: var(--space-400);
    min-height: 2.75rem;
    padding: var(--space-400);
    text-align: left;
    width: 100%;
  }

  .forum-thread-button:hover {
    background: var(--sable-surface-container-hover);
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
    font-weight: var(--font-weight-bold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-time {
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
  }

  .forum-thread-preview {
    color: var(--sable-surface-on-container);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-meta {
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    overflow: hidden;
  }

  .forum-thread-replies {
    flex: 0 0 auto;
  }

  .forum-thread-last {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-unread-dot {
    background: var(--sable-primary-main);
    border-radius: 50%;
    flex: 0 0 auto;
    height: 0.5rem;
    width: 0.5rem;
  }
</style>
