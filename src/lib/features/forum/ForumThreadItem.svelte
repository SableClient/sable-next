<script lang="ts">
  import { copyText } from '#lib/platform/clipboard.js';
  import { onDestroy } from 'svelte';

  import DeleteMessageDialog from '#lib/features/room/messages/DeleteMessageDialog.svelte';
  import MessageActions from '#lib/features/room/messages/MessageActions.svelte';
  import MessageActionSheet from '#lib/features/room/messages/MessageActionSheet.svelte';
  import { useMessageMenu } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import { formatMessageTimestamp } from '#lib/ui/date-time.js';
  import { i18n } from '#lib/i18n.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { LongPress, touchContextMenu } from '#lib/ui/long-press.svelte.js';
  import MessagePreview from '#lib/features/room/messages/MessagePreview.svelte';
  import { opensFrom } from '#lib/features/room/messages/message-preview.js';

  import { VOTE, type ForumThread } from './forum-threads';

  interface Props {
    thread: ForumThread;
    onOpen: (eventId: string) => void;
    canDelete: boolean;
    onEdit?: (thread: ForumThread) => void;
    onDelete: (eventId: string, reason: string | null) => void;
    roomId: string;
    onReact?: (eventId: string, key: string) => void;
    onCopyLink: (eventId: string) => void;
    pinned?: boolean;
    onPin?: (eventId: string) => void;
  }

  let {
    thread,
    onOpen,
    canDelete,
    onEdit,
    onDelete,
    roomId,
    onReact,
    onCopyLink,
    pinned = false,
    onPin,
  }: Props = $props();
  let deleteOpen = $state(false);
  let sheetOpen = $state(false);

  let displayName = $derived(thread.senderName ?? thread.sender ?? '');
  let replyLabel = $derived(
    thread.replyCount === 1
      ? i18n.t('forum.replyCount_one', { count: thread.replyCount })
      : i18n.t('forum.replyCount_other', { count: thread.replyCount })
  );
  let voteLabel = $derived(
    thread.votes === 1
      ? i18n.t('forum.vote_one', { count: thread.votes })
      : i18n.t('forum.vote_other', { count: thread.votes })
  );
  let accessibleLabel = $derived(
    thread.unread
      ? i18n.t('forum.threadUnread', { name: displayName, preview: thread.preview })
      : i18n.t('forum.thread', { name: displayName, preview: thread.preview })
  );
  let actions = $derived({
    roomId,
    onReact: onReact ? (key: string) => onReact(thread.eventId, key) : undefined,
    onOpenThread: () => onOpen(thread.eventId),
    onEdit: thread.editable && onEdit ? () => onEdit(thread) : undefined,
    onCopyText:
      thread.preview === ''
        ? undefined
        : () => {
            void copyText(thread.preview)
              .then(() => toasts.info(i18n.t('common.copied')))
              .catch(() => toasts.error(i18n.t('errors.actionFailed')));
          },
    onCopyLink: () => onCopyLink(thread.eventId),
    onPin: onPin ? () => onPin(thread.eventId) : undefined,
    pinned,
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
    class={['forum-thread-card', { pressed: rowPress.pressing, unread: thread.unread, pinned }]}
    onpointerdown={rowPress.start}
    onpointermove={rowPress.move}
    onpointerup={rowPress.end}
    onpointercancel={rowPress.end}
    oncontextmenu={openContextMenu}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="forum-thread-button"
      onclick={(event) => {
        if (opensFrom(event)) onOpen(thread.eventId);
      }}
    >
      {#if thread.title}
        <h3 class="forum-thread-title">{thread.title}</h3>
      {/if}
      <MessagePreview {roomId} eventId={thread.eventId} item={thread.item}>
        {#snippet fallback()}
          <span class="forum-thread-preview">{thread.preview}</span>
        {/snippet}
      </MessagePreview>
      <div class="forum-thread-meta">
        {#if onReact}
          <button
            type="button"
            class={['forum-thread-vote', { voted: thread.ownVote !== null }]}
            aria-label={voteLabel}
            aria-pressed={thread.ownVote !== null}
            onclick={() => onReact(thread.eventId, thread.ownVote ?? VOTE)}
          >
            {VOTE}
            {thread.votes}
          </button>
        {:else if thread.votes > 0}
          <span class="forum-thread-votes">{VOTE} {thread.votes}</span>
        {/if}
        <button
          type="button"
          class="forum-thread-open"
          aria-label={accessibleLabel}
          onclick={() => onOpen(thread.eventId)}
        >
          <span class="forum-thread-replies">{replyLabel}</span>
          {#if thread.lastBody}
            <span class="forum-thread-last">
              {thread.lastSenderName ?? displayName}: {thread.lastBody}
            </span>
          {/if}
          <span class="forum-thread-time">{formatMessageTimestamp(thread.lastActivityAt)}</span>
          {#if thread.unread}
            <span class="forum-thread-unread-dot" aria-hidden="true"></span>
          {/if}
        </button>
      </div>
    </div>
    <MessageActions {...actions} />
  </article>
</li>

<DeleteMessageDialog
  bind:open={deleteOpen}
  preview={thread.preview}
  title={i18n.t('forum.deleteThreadTitle')}
  description={i18n.t('forum.deleteThreadExplain')}
  confirmLabel={i18n.t('forum.deleteThread')}
  onConfirm={(reason) => onDelete(thread.eventId, reason)}
/>

<MessageActionSheet bind:open={sheetOpen} preview={thread.preview} {...actions} />

<style>
  .forum-thread-item {
    list-style: none;
    margin-top: var(--space-300);
  }

  .forum-thread-button {
    box-sizing: border-box;
    cursor: pointer;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-300);
    min-width: 0;
    padding: var(--space-300) var(--space-400);
  }

  .forum-thread-card {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radii-400);
    color: var(--surface-var-on-container);
    display: flex;
    position: relative;
  }

  .forum-thread-card.pinned {
    border-color: var(--primary-main);
  }

  .forum-thread-card.unread {
    box-shadow: inset 0.1875rem 0 0 var(--primary-main);
  }

  .forum-thread-card:has(.forum-thread-button:hover),
  .forum-thread-card:has(.forum-thread-meta:focus-visible) {
    background: var(--surface-container-hover);
    color: var(--surface-on-container);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .forum-thread-card:hover :global(.message-actions),
    .forum-thread-card:focus-within :global(.message-actions) {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .forum-thread-card.pressed {
    background: var(--surface-container-hover);
    color: var(--surface-on-container);
  }

  .forum-thread-title {
    color: var(--surface-on-container);
    font-size: var(--font-size-subheading);
    font-weight: var(--font-weight-600);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .forum-thread-time {
    flex: 0 0 auto;
    margin-inline-start: auto;
  }

  .forum-thread-preview {
    color: inherit;
    font-weight: var(--font-weight-500);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-meta {
    align-items: center;
    border-top: var(--border-width) solid var(--bg-container-line);
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    padding: var(--space-200) 0 0;
  }

  .forum-thread-open {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1 1 auto;
    font: inherit;
    gap: var(--space-300);
    min-width: 0;
    overflow: hidden;
    padding: 0;
    text-align: start;
  }

  .forum-thread-vote {
    background: var(--surface-container);
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    cursor: pointer;
    flex: 0 0 auto;
    font: inherit;
    padding: var(--space-050) var(--space-200);
  }

  .forum-thread-vote.voted {
    background: var(--primary-container);
    border-color: var(--primary-container-line);
    color: var(--primary-on-container);
  }

  .forum-thread-vote:focus-visible,
  .forum-thread-open:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
  }

  .forum-thread-replies {
    background: var(--surface-container);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    flex: 0 0 auto;
    padding: var(--space-050) var(--space-200);
  }

  .forum-thread-votes {
    flex: 0 0 auto;
  }

  .forum-thread-card.unread .forum-thread-replies {
    background: var(--primary-container);
    color: var(--primary-on-container);
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
