<script lang="ts">
  import { copyText } from '#lib/platform/clipboard.js';
  import { onDestroy, untrack } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { UserProfile } from '#lib/profile/user-profile.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { useSenderColors } from '#lib/features/room/members/members.js';
  import SenderName from '#lib/features/room/members/SenderName.svelte';
  import { useRoomScopes } from '#lib/features/room/messages/message-scope.svelte.js';
  import { MessageSender } from '#lib/features/room/timeline/message-sender.svelte.js';

  import DeleteMessageDialog from '#lib/features/room/messages/DeleteMessageDialog.svelte';
  import MessageActions from '#lib/features/room/messages/MessageActions.svelte';
  import MessageActionSheet from '#lib/features/room/messages/MessageActionSheet.svelte';
  import { useMessageMenu } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import { formatMessageTimestamp } from '#lib/ui/date-time.js';
  import { i18n } from '#lib/i18n.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { LongPress, touchContextMenu } from '#lib/ui/long-press.svelte.js';
  import { opensFrom } from '#lib/features/room/messages/message-preview.js';
  import { replyPreviewBody } from '#lib/features/room/messages/reply-preview.js';
  import {
    hasRoomMediaPreviews,
    useRoomMediaPreviews,
  } from '#lib/features/room/media/room-media-previews.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';

  import type { ForumThreadCallbacks } from './forum-thread-callbacks';
  import { VOTE, type ForumLayout, type ForumThread } from './forum-threads';

  interface Props extends ForumThreadCallbacks {
    thread: ForumThread;
    canDelete: boolean;
    roomId: string;
    pinned?: boolean;
    layout?: ForumLayout;
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
    layout = 'list',
  }: Props = $props();
  const roomMedia = hasRoomMediaPreviews() ? useRoomMediaPreviews() : null;
  const scope = useRoomScopes().acquire(untrack(() => roomId));
  onDestroy(scope.release);
  const colorsFor = useSenderColors();
  const profile = new UserProfile(useCoreClient(), () => thread.sender);
  const sender = new MessageSender(() => ({
    item: thread.item,
    members: [],
    profile: profile.current,
    cosmetics: scope.cosmetics.for(thread.sender),
  }));
  let senderColors = $derived(
    colorsFor(thread.sender, profile.current, {
      persona: sender.persona,
      isOwn: thread.isOwn,
      cosmetics: scope.cosmetics.for(thread.sender),
    })
  );
  let deleteOpen = $state(false);
  let sheetOpen = $state(false);

  let displayName = $derived(sender.name);
  let summary = $derived(replyPreviewBody(thread.item.content).replace(/\s+/g, ' ').trim());
  let heading = $derived(thread.title || summary);
  let gallery = $derived(layout === 'gallery');
  let mediaHidden = $derived((thread.thumbnail?.spoiler ?? false) || (roomMedia?.hidden ?? false));
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
  let activityTime = $derived(formatMessageTimestamp(thread.lastActivityAt));
  let accessibleLabel = $derived.by(() => {
    const values = {
      name: displayName,
      preview: thread.title || thread.preview,
      replies: replyLabel,
      time: activityTime,
    };
    return thread.unread ? i18n.t('forum.threadUnread', values) : i18n.t('forum.thread', values);
  });
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
    onCopyMatrixLink: () => onCopyLink(thread.eventId, 'matrix'),
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

<li class={['forum-thread-item', { gallery, 'has-media': thread.thumbnail !== null }]}>
  <article
    class={['forum-thread-card', { pressed: rowPress.pressing, unread: thread.unread }]}
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
      <div class="forum-thread-text">
        {#if heading}
          <h3 class="forum-thread-title">
            {#if pinned}
              <PushPinIcon weight="fill" aria-label={i18n.t('forum.pinnedThread')} />
            {/if}
            {heading}
          </h3>
        {/if}
        <p class="forum-thread-summary">
          <Avatar
            class="forum-thread-avatar"
            src={sender.avatar}
            size="tiny"
            id={sender.tint ? null : thread.sender}
            name={displayName}
          />
          <SenderName
            {displayName}
            colors={senderColors}
            nameClass="forum-thread-author"
            compact
          />{#if thread.title && summary}<span class="forum-thread-preview">: {summary}</span>{/if}
        </p>
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
            <span class="forum-thread-replies">
              <ChatCircleIcon size={14} aria-hidden="true" />
              {replyLabel}
            </span>
            {#if thread.lastBody}
              <span class="forum-thread-last">
                {thread.lastSenderName ?? displayName}: {thread.lastBody}
              </span>
            {/if}
            <span class="forum-thread-time">{activityTime}</span>
            {#if thread.unread}
              <span class="forum-thread-unread-dot" aria-hidden="true"></span>
            {/if}
          </button>
        </div>
      </div>
      {#if thread.thumbnail}
        <div class="forum-thread-media">
          {#if mediaHidden}
            <EyeSlashIcon aria-hidden="true" />
          {:else}
            <MediaImage
              class="forum-thread-image privacy-media"
              style={gallery ? 'aspect-ratio: 16 / 9' : 'aspect-ratio: 1 / 1'}
              source={thread.thumbnail.source}
              thumbnail={thread.thumbnail.thumbnail}
              alt=""
              width={gallery ? 480 : 160}
              height={gallery ? 270 : 160}
              intrinsicWidth={thread.thumbnail.width}
              intrinsicHeight={thread.thumbnail.height}
              blurhash={thread.thumbnail.blurhash}
            />
            {#if thread.thumbnail.video}
              <span class="forum-thread-play" aria-hidden="true"><PlayIcon weight="fill" /></span>
            {/if}
          {/if}
        </div>
      {/if}
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
    container-type: inline-size;
    list-style: none;
    min-width: 0;
  }

  .forum-thread-card {
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radii-400);
    color: var(--surface-var-on-container);
    display: flex;
    height: 100%;
    position: relative;
  }

  .forum-thread-button {
    box-sizing: border-box;
    cursor: pointer;
    display: flex;
    flex: 1;
    gap: var(--space-400);
    min-width: 0;
    padding: var(--space-300) var(--space-400);
  }

  .forum-thread-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-100);
    min-width: 0;
  }

  .forum-thread-card:has(.forum-thread-button:hover),
  .forum-thread-card:has(.forum-thread-meta :focus-visible),
  .forum-thread-card.pressed {
    background: var(--surface-container-hover);
  }

  /* Not any-hover: phones report it, and a tap there shows actions that vanish on release. */
  @media (hover: hover) and (pointer: fine) {
    .forum-thread-card:hover :global(.message-actions),
    .forum-thread-card:focus-within :global(.message-actions) {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .forum-thread-title,
  .forum-thread-summary {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .forum-thread-title {
    font-size: var(--font-size-subheading);
    font-weight: var(--font-weight-500);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: var(--line-height-heading);
  }

  .forum-thread-card.unread .forum-thread-title {
    color: var(--surface-on-container);
    font-weight: var(--font-weight-600);
  }

  .forum-thread-title :global(svg) {
    color: var(--primary-main);
    height: 0.875em;
    margin-inline-end: var(--space-100);
    vertical-align: -0.0625em;
    width: 0.875em;
  }

  .forum-thread-summary {
    font-size: var(--font-size-label);
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .forum-thread-summary :global(.forum-thread-avatar) {
    margin-inline-end: var(--space-100);
    vertical-align: middle;
  }

  .forum-thread-summary :global(.forum-thread-author) {
    display: inline;
    white-space: normal;
  }

  .forum-thread-meta {
    align-items: center;
    display: flex;
    font-size: var(--font-size-label);
    gap: var(--space-300);
    margin-top: auto;
    padding-top: var(--space-150);
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
    font-variant-numeric: tabular-nums;
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
    align-items: center;
    display: inline-flex;
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    gap: var(--space-100);
  }

  .forum-thread-card.unread .forum-thread-replies {
    color: var(--surface-on-container);
    font-weight: var(--font-weight-500);
  }

  @media (pointer: coarse) {
    .forum-thread-vote {
      position: relative;
    }

    .forum-thread-vote::after {
      content: '';
      inset: calc((100% - var(--target-hit)) / 2) 0;
      position: absolute;
    }
  }

  .forum-thread-votes {
    flex: 0 0 auto;
  }

  .forum-thread-time {
    flex: 0 1 auto;
    margin-inline-start: auto;
  }

  .forum-thread-time,
  .forum-thread-last {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forum-thread-last {
    flex: 0 9999 auto;
  }

  .forum-thread-card :global(.message-actions) {
    bottom: auto;
    top: var(--space-200);
  }

  .forum-thread-unread-dot {
    background: var(--primary-main);
    border-radius: 50%;
    flex: 0 0 auto;
    height: 0.5rem;
    width: 0.5rem;
  }

  .forum-thread-media {
    align-items: center;
    align-self: center;
    background: var(--surface-container);
    border-radius: var(--radius);
    display: flex;
    flex: 0 0 auto;
    height: 4.5rem;
    justify-content: center;
    overflow: hidden;
    position: relative;
    width: 4.5rem;
  }

  .forum-thread-media :global(.forum-thread-image) {
    height: 100%;
    width: 100%;
  }

  .forum-thread-media > :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .forum-thread-play {
    align-items: center;
    background: var(--surface-var-container);
    border-radius: 50%;
    color: var(--surface-on-container);
    display: flex;
    inset-block-end: var(--space-100);
    inset-inline-end: var(--space-100);
    padding: var(--space-100);
    position: absolute;
  }

  .gallery .forum-thread-button {
    flex-direction: column-reverse;
    gap: var(--space-300);
    justify-content: flex-end;
    padding: var(--space-300);
  }

  .gallery .forum-thread-media {
    align-self: stretch;
    aspect-ratio: 16 / 9;
    height: auto;
    width: auto;
  }

  .gallery .forum-thread-summary {
    -webkit-line-clamp: 6;
    line-clamp: 6;
  }

  .gallery.has-media .forum-thread-summary {
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .gallery .forum-thread-last {
    display: none;
  }

  @container (width < 32rem) {
    .forum-thread-last {
      display: none;
    }
  }
</style>
