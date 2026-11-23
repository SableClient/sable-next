<script lang="ts">
  import { untrack } from 'svelte';
  import { ThreadRoots } from '#lib/rooms/thread-roots.svelte.js';
  import type { MemberView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import MessagePreview from '../messages/MessagePreview.svelte';
  import { opensFrom } from '../messages/message-preview';
  import { replyPreviewBody } from '../messages/reply-preview.js';
  import TimelineThreadSummary from '../timeline/TimelineThreadSummary.svelte';
  import ThreadReactionPreview from './ThreadReactionPreview.svelte';
  import ThreadSidebarActions from './ThreadSidebarActions.svelte';

  interface Props {
    roomId: string;
    threads?: ThreadRoots;
    members: readonly MemberView[];
    onOpenThread: (rootEventId: string) => void;
  }

  let { roomId, threads, members, onOpenThread }: Props = $props();

  const core = useCoreClient();
  const local = new ThreadRoots(core);
  let source = $derived(threads ?? local);
  let currentUserId = $derived(core.session?.user_id ?? null);

  $effect(() => {
    if (threads) return;
    const id = roomId;
    void untrack(() => local.start(id));
    return () => local.stop();
  });
</script>

{#if source.items.length > 0}
  <ul>
    {#each source.byActivity as root (root.event_id ?? root.id)}
      {@const rootId = root.event_id ?? root.id}
      {@const latestId = root.thread_summary?.latest_event_id ?? null}
      {@const latestItem = source.latestById.get(latestId)}
      {@const summary = root.thread_summary
        ? {
            ...root.thread_summary,
            latest_body:
              (latestItem && replyPreviewBody(latestItem.content)) ||
              root.thread_summary.latest_body,
            latest_sender: root.thread_summary.latest_sender ?? latestItem?.sender ?? null,
            latest_timestamp: root.thread_summary.latest_timestamp ?? latestItem?.timestamp ?? null,
          }
        : null}
      <li>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="thread-root"
          onclick={(event) => {
            if (opensFrom(event)) onOpenThread(rootId);
          }}
        >
          <MessagePreview {roomId} eventId={rootId} item={root} {members} loadPreviewProfile>
            {#snippet headerAction()}
              <ThreadSidebarActions {roomId} {rootId} {root} compact />
            {/snippet}
            {#snippet fallback()}{/snippet}
          </MessagePreview>
        </div>
        <div class="thread-details">
          {#if root.event_id && root.reactions.length === 0}
            <ThreadReactionPreview {roomId} eventId={root.event_id} {members} {currentUserId} />
          {/if}
          <TimelineThreadSummary
            {summary}
            unread={source.activity.get(rootId)}
            {roomId}
            {rootId}
            rootSender={root.sender}
            {members}
            {currentUserId}
            persona={latestItem?.per_message_profile ?? null}
            emptyLabel={i18n.t('timeline.threadOpen')}
            fullWidth
            onOpen={() => {
              onOpenThread(rootId);
            }}
          />
          {#if latestId}
            <ThreadReactionPreview
              {roomId}
              eventId={latestId}
              known={latestItem?.reactions}
              {members}
              {currentUserId}
            />
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{:else if !source.loading && !source.error}
  <p class="thread-list-status">{i18n.t('timeline.threadsEmpty')}</p>
{/if}

{#if source.error}
  <p class="thread-list-status" role="alert">{i18n.t('timeline.threadsFailed')}</p>
{/if}
{#if source.loading}
  <div class="thread-list-loading"><Spinner small /></div>
{:else if source.nextBatch !== null || source.error}
  <div class="thread-list-more">
    <Button
      size="small"
      variant="secondary"
      onclick={() => void (source.error ? source.retry() : source.loadMore())}
    >
      {source.error ? i18n.t('common.tryAgain') : i18n.t('timeline.threadsLoadMore')}
    </Button>
  </div>
{/if}

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    color: var(--bg-on-container);
    display: grid;
    min-width: 0;
    padding: var(--space-250) var(--space-300);
  }

  li + li {
    border-top: var(--border-width) solid var(--bg-container-line);
  }

  li:is(:hover, :focus-within) {
    background: var(--bg-container-hover);
  }

  .thread-root {
    cursor: pointer;
    min-width: 0;
  }

  .thread-details {
    min-width: 0;
    padding-inline-start: calc(var(--avatar-size-small) + var(--timeline-row-gap));
  }

  .thread-list-status {
    color: var(--surface-var-on-container);
    margin: 0;
    padding: var(--space-400);
  }

  .thread-list-loading,
  .thread-list-more {
    display: flex;
    justify-content: center;
    padding: var(--space-300);
  }
</style>
