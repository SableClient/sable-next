<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import DeleteMessageDialog from '#lib/features/room/DeleteMessageDialog.svelte';
  import { formatMessageTimestamp } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import type { ForumThread } from './forum-threads';

  interface Props {
    thread: ForumThread;
    onOpen: (eventId: string) => void;
    canDelete: boolean;
    onEdit: (thread: ForumThread) => void;
    onDelete: (eventId: string, reason: string | null) => void;
  }

  let { thread, onOpen, canDelete, onEdit, onDelete }: Props = $props();
  let deleteOpen = $state(false);

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
  <div class="forum-thread-card">
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
    {#if thread.editable || canDelete}
      <ActionMenu label={$i18n.t('timeline.moreActions')}>
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            class="forum-thread-actions"
            size="small"
            variant="ghost"
            label={$i18n.t('timeline.moreActions')}
          >
            <DotsThreeIcon />
          </IconButton>
        {/snippet}
        <IconContext values={{ 'aria-hidden': 'true' }}>
          {#if thread.editable}
            <ActionMenuItem onSelect={() => onEdit(thread)}>
              <EditIcon />
              <span>{$i18n.t('timeline.editMessage')}</span>
            </ActionMenuItem>
          {/if}
          {#if canDelete}
            {#if thread.editable}<ActionMenuSeparator />{/if}
            <ActionMenuItem destructive onSelect={() => (deleteOpen = true)}>
              <TrashIcon />
              <span>{$i18n.t('timeline.deleteMessage')}</span>
            </ActionMenuItem>
          {/if}
        </IconContext>
      </ActionMenu>
    {/if}
  </div>
</li>

<DeleteMessageDialog
  bind:open={deleteOpen}
  preview={thread.preview}
  onConfirm={(reason) => onDelete(thread.eventId, reason)}
/>

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
  }

  .forum-thread-card:has(.forum-thread-button:hover),
  .forum-thread-card:has(.forum-thread-button:focus-visible) {
    background: var(--surface-container-hover);
  }

  :global(.forum-thread-actions) {
    flex: 0 0 auto;
    margin-inline-end: var(--space-200);
  }

  @media (hover: hover) and (pointer: fine) {
    :global(.forum-thread-actions) {
      opacity: 0;
    }

    .forum-thread-card:hover :global(.forum-thread-actions),
    :global(.forum-thread-actions:focus-visible) {
      opacity: 1;
    }
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
