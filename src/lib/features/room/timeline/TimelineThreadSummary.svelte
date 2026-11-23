<script lang="ts">
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import ThreadIcon from 'phosphor-svelte/lib/ScribbleLoopIcon';

  import type {
    MemberView,
    PerMessageProfileView,
    ThreadSummaryView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { useThreadSidebar } from '#lib/features/sidebar/thread-sidebar.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { UserProfile } from '#lib/profile/user-profile.svelte.js';
  import type { ThreadUnread } from '#lib/rooms/thread-roots.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { formatMessageTimestamp } from '#lib/ui/date-time.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { formatUnreadCount } from '#lib/ui/primitives/unread-badge.js';
  import { whenVisible } from '#lib/ui/when-visible.js';

  import {
    findMember,
    memberAvatar,
    memberName,
    stripReplyFallback,
    useSenderColors,
  } from '../members/members.js';
  import SenderName from '../members/SenderName.svelte';
  import { fallbackText } from '../messages/reply-fallback.js';
  import {
    cachedThreadReplies,
    loadThreadReplies,
    threadParticipants,
    threadReplyRevision,
  } from '#lib/rooms/thread-replies.js';
  import PreviewSegments from '../messages/PreviewSegments.svelte';
  import { previewSegments } from '../messages/reply-preview.js';
  import {
    hasRoomMediaPreviews,
    useRoomMediaPreviews,
  } from '../media/room-media-previews.svelte.js';

  const MAX_PARTICIPANTS = 3;

  interface Props {
    summary: ThreadSummaryView | null;
    unread?: ThreadUnread;
    roomId?: string;
    rootId?: string | null;
    rootSender?: string | null;
    members?: readonly MemberView[];
    currentUserId?: string | null;
    persona?: PerMessageProfileView | null;
    preview?: boolean;
    emptyLabel?: string;
    fullWidth?: boolean;
    onOpen: () => void;
  }

  let {
    summary,
    unread,
    roomId = '',
    rootId = null,
    rootSender = null,
    members = [],
    currentUserId = null,
    persona = null,
    preview = false,
    emptyLabel,
    fullWidth = false,
    onOpen,
  }: Props = $props();

  const core = useCoreClient();
  const sidebar = useThreadSidebar();
  const senderColors = useSenderColors();
  const roomMedia = hasRoomMediaPreviews() ? useRoomMediaPreviews() : null;
  let visible = $state(false);
  let fetchedParticipants = $state.raw<readonly string[] | null>(null);

  let unreadState = $derived(
    unread ?? (rootId && roomId ? sidebar?.unreadState(roomId, rootId) : undefined)
  );
  let latest = $derived(
    summary
      ? stripReplyFallback(
          fallbackText(summary.latest_body, summary.latest_fallback, i18n.t),
          persona
        )
      : ''
  );
  let latestSender = $derived(summary?.latest_sender ?? null);
  let latestTimestamp = $derived(summary?.latest_timestamp ?? null);
  const latestProfile = new UserProfile(core, () => (preview ? null : latestSender));
  let latestSenderMember = $derived(latestSender ? findMember(members, latestSender) : null);
  let latestSenderName = $derived(
    persona?.display_name ??
      latestSenderMember?.display_name ??
      latestProfile.current?.display_name ??
      latestSender
  );
  let latestSenderAvatar = $derived(
    persona?.avatar_url ??
      latestSenderMember?.avatar_url ??
      latestProfile.current?.avatar_url ??
      null
  );
  let latestSenderColors = $derived(
    senderColors(latestSender, latestProfile.current, {
      persona,
      isOwn: currentUserId !== null && latestSender === currentUserId,
    })
  );
  let revision = $derived(summary ? threadReplyRevision(summary) : '');

  $effect(() => {
    fetchedParticipants = null;
    if (!visible || preview || !roomId || !rootId || !summary || summary.num_replies <= 1) {
      return;
    }
    const cached = cachedThreadReplies(roomId, rootId, revision);
    if (cached) {
      fetchedParticipants = threadParticipants(cached);
      return;
    }
    let current = true;
    void loadThreadReplies(core, roomId, rootId, revision).then(
      (replies) => {
        if (current) fetchedParticipants = threadParticipants(replies);
      },
      (error: unknown) => {
        console.debug('[sable threads] participants unavailable', error);
      }
    );
    return () => {
      current = false;
    };
  });

  let participants = $derived.by(() => {
    const seen: string[] = [];
    for (const userId of [latestSender, ...(fetchedParticipants ?? []), rootSender]) {
      if (userId && !seen.includes(userId)) seen.push(userId);
    }
    return seen;
  });
  let faces = $derived(participants.slice(0, MAX_PARTICIPANTS));
  let overflow = $derived(Math.max(0, participants.length - MAX_PARTICIPANTS));
</script>

<button
  type="button"
  class={[
    'thread-summary',
    { compact: !summary, full: fullWidth, unread: unreadState !== undefined },
  ]}
  onclick={onOpen}
  {@attach whenVisible(() => (visible = true))}
>
  <span class="thread-meta">
    <ThreadIcon size={14} aria-hidden="true" />
    <span class="thread-count">
      {summary
        ? i18n.t('timeline.threadReplies', { count: summary.num_replies })
        : (emptyLabel ?? i18n.t('timeline.thread'))}
    </span>
    <CaretRightIcon class="thread-chevron mirror-rtl" size={12} weight="bold" aria-hidden="true" />
    {#if unreadState}
      {#if unreadState.replies > 0}
        <span class="thread-unread-count">
          <span aria-hidden="true"
            >{formatUnreadCount(unreadState.replies, preferences.showEasterEggs)}</span
          >
          <span class="screen-reader-only">
            {i18n.t('timeline.threadUnreadReplies', { count: unreadState.replies })}
          </span>
        </span>
      {:else}
        <span class="thread-unread-dot">
          <span class="screen-reader-only">
            {i18n.t(unreadState.fresh ? 'timeline.threadNew' : 'timeline.threadUnread')}
          </span>
        </span>
      {/if}
    {/if}
    {#if summary && faces.length > 0}
      <span class="thread-participants" aria-hidden="true">
        {#each faces as userId (userId)}
          {@const name =
            userId === latestSender && latestSenderName
              ? latestSenderName
              : memberName(members, userId)}
          {@const avatar =
            userId === latestSender ? latestSenderAvatar : memberAvatar(members, userId)}
          <Avatar class="thread-face" src={avatar} {name} id={userId} />
        {/each}
        {#if overflow > 0}
          <span class="thread-overflow">+{overflow}</span>
        {/if}
      </span>
    {/if}
  </span>
  {#if summary && (latest || latestSenderName || latestTimestamp !== null)}
    <span class="thread-preview">
      {#if latestSenderName}
        <SenderName
          displayName={latestSenderName}
          colors={latestSenderColors}
          nameClass="thread-sender"
          compact
        />
      {/if}
      {#if latest}
        <span class="thread-latest"
          ><bdi
            ><PreviewSegments
              segments={previewSegments(latest, roomMedia?.hidden ? [] : summary.latest_emotes)}
            /></bdi
          ></span
        >
      {/if}
      {#if latestTimestamp !== null}
        <time class="thread-time" datetime={new Date(latestTimestamp).toISOString()}>
          {formatMessageTimestamp(latestTimestamp)}
        </time>
      {/if}
    </span>
  {/if}
</button>

<style>
  .thread-summary {
    --stack-ring: var(--surface-container);

    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    cursor: pointer;
    display: grid;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    margin-top: var(--space-150);
    max-width: min(34rem, 100%);
    min-width: min(14rem, 100%);
    padding: var(--space-150) var(--space-250);
    text-align: start;
    width: fit-content;
  }

  .thread-summary.compact {
    min-width: 0;
  }

  .thread-summary.full:not(.compact) {
    max-width: 100%;
    min-width: 0;
    width: 100%;
  }

  .thread-meta {
    align-items: center;
    color: var(--primary-main);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-150);
    min-width: 0;
  }

  .thread-meta :global(svg) {
    flex: none;
  }

  .thread-meta :global(.thread-chevron) {
    opacity: var(--opacity-p300);
  }

  .thread-count {
    flex: none;
    font-weight: var(--font-weight-medium);
  }

  .thread-summary.unread .thread-count {
    font-weight: var(--font-weight-bold);
  }

  .thread-unread-count,
  .thread-overflow {
    align-items: center;
    border-radius: var(--radius-pill);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    justify-content: center;
  }

  .thread-unread-count {
    background: var(--primary-main);
    box-sizing: border-box;
    color: var(--primary-on-main);
    flex: none;
    font-weight: var(--font-weight-medium);
    height: var(--size-x50);
    line-height: var(--size-x50);
    min-width: var(--size-x50);
    padding: 0 var(--space-100);
  }

  .thread-unread-dot {
    background: var(--primary-main);
    border-radius: var(--radii-round);
    display: inline-block;
    flex: none;
    height: var(--space-200);
    width: var(--space-200);
  }

  .thread-participants {
    --face-size: 1.125rem;

    align-items: center;
    display: inline-flex;
    flex: none;
    margin-inline-start: auto;
    padding-inline-start: var(--space-100);
  }

  .thread-participants > :global(* + *) {
    margin-inline-start: calc(-1 * var(--space-100));
  }

  :global(.avatar-root.thread-face) {
    --avatar-size: var(--face-size);

    background: var(--stack-ring);
    box-shadow: 0 0 0 0.125rem var(--stack-ring);
    font-size: var(--font-size-small);
  }

  .thread-overflow {
    background: var(--surface-container-active);
    box-shadow: 0 0 0 0.125rem var(--stack-ring);
    color: var(--surface-on-container);
    height: var(--face-size);
    line-height: 1;
    min-width: var(--face-size);
    padding: 0 var(--space-050);
  }

  .thread-preview {
    align-items: baseline;
    display: flex;
    gap: var(--space-150);
    min-width: 0;
  }

  :global(.thread-sender),
  .thread-latest {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.thread-sender) {
    flex: none;
    font-weight: var(--font-weight-medium);
    max-width: 10rem;
  }

  .thread-latest {
    color: var(--surface-on-container);
    flex: 1;
    min-width: 0;
  }

  .thread-time {
    color: var(--surface-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    opacity: var(--opacity-p300);
    white-space: nowrap;
  }

  .thread-summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (prefers-reduced-motion: no-preference) {
    .thread-summary {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        border-color var(--motion-normal) var(--motion-easing-standard);
    }
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .thread-summary:hover {
      --stack-ring: var(--surface-container-hover);

      background: var(--surface-container-hover);
      border-color: var(--primary-container-line);
    }
  }

  .thread-summary:active {
    --stack-ring: var(--surface-container-active);

    background: var(--surface-container-active);
  }
</style>
