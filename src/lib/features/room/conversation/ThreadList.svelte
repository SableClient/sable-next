<script lang="ts">
  import { untrack } from 'svelte';
  import { ThreadRoots } from '#lib/rooms/thread-roots.svelte.js';
  import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import type { MemberView } from '#src/generated/protocol';
  import ThreadIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { fallbackText } from '../messages/reply-fallback.js';
  import { stripReplyFallback } from '../members/members.js';
  import MessagePreview from '../messages/MessagePreview.svelte';
  import RoomSidePanel from '../RoomSidePanel.svelte';
  import { opensFrom } from '../messages/message-preview';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onOpenThread: (rootEventId: string) => void;
    onClose: () => void;
  }

  let { roomId, members, modal = false, onOpenThread, onClose }: Props = $props();

  const core = useCoreClient();
  const threads = new ThreadRoots(core);
  const timeline = new RoomTimeline(core);

  $effect(() => {
    const id = roomId;
    void untrack(() => timeline.start(id));
    void untrack(() => threads.start(id));
    return () => {
      threads.stop();
      void timeline.stop();
    };
  });
</script>

<RoomSidePanel
  title={i18n.t('timeline.threadsTitle')}
  closeLabel={i18n.t('timeline.threadsClose')}
  resizeLabel={i18n.t('timeline.threadsResize')}
  widthKey="sable-thread-list-width"
  width={22}
  body="flush"
  {modal}
  {onClose}
>
  {#snippet icon()}
    <ChatsIcon aria-hidden="true" />
  {/snippet}
  {#if threads.items.length > 0}
    <ul>
      {#each threads.items as root (root.id)}
        {@const rootId = root.event_id ?? root.id}
        {@const threadOpenLabel = i18n.t('timeline.threadOpen')}
        <li>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="thread-root"
            onclick={(event) => {
              if (opensFrom(event)) onOpenThread(rootId);
            }}
          >
            <MessagePreview {roomId} eventId={rootId} item={root} {members} loadPreviewProfile>
              {#snippet fallback()}{/snippet}
            </MessagePreview>
          </div>
          <Tooltip label={threadOpenLabel} disabled={!!root.thread_summary}>
            {#snippet trigger({ props })}
              <button
                {...props}
                type="button"
                class={['thread-summary', { 'no-summary': !root.thread_summary }]}
                aria-label={root.thread_summary ? undefined : threadOpenLabel}
                onclick={() => {
                  onOpenThread(rootId);
                }}
              >
                <ThreadIcon size={14} aria-hidden="true" />
                {#if root.thread_summary}
                  <span class="thread-count">
                    {i18n.t('timeline.threadReplies', {
                      count: root.thread_summary.num_replies,
                    })}
                  </span>
                {/if}
                {#if root.thread_summary}
                  {@const latest = stripReplyFallback(
                    fallbackText(
                      root.thread_summary.latest_body,
                      root.thread_summary.latest_fallback,
                      i18n.t
                    ),
                    null
                  )}
                  {#if latest}
                    <span class="thread-latest">{latest}</span>
                  {/if}
                {/if}
              </button>
            {/snippet}
          </Tooltip>
        </li>
      {/each}
    </ul>
  {:else if !threads.loading && !threads.error}
    <p class="thread-list-status">{i18n.t('timeline.threadsEmpty')}</p>
  {/if}

  {#if threads.error}
    <p class="thread-list-status" role="alert">{i18n.t('timeline.threadsFailed')}</p>
  {/if}
  {#if threads.loading}
    <div class="thread-list-loading"><Spinner small /></div>
  {:else if threads.nextBatch !== null || threads.error}
    <div class="thread-list-more">
      <Button
        size="small"
        variant="secondary"
        onclick={() => void (threads.error ? threads.retry() : threads.loadMore())}
      >
        {threads.error ? i18n.t('common.tryAgain') : i18n.t('timeline.threadsLoadMore')}
      </Button>
    </div>
  {/if}
</RoomSidePanel>

<style>
  ul {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: var(--space-200);
  }

  li {
    background: var(--surface-container);
    border-radius: var(--radius-inner);
    color: var(--surface-on-container);
    display: grid;
    min-width: 0;
    padding: var(--space-100) var(--space-300) var(--space-300);
  }

  .thread-summary {
    align-items: start;
    background: none;
    border: none;
    border-radius: var(--radius);
    color: var(--primary-main);
    cursor: pointer;
    display: grid;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100) var(--space-200);
    grid-template-columns: auto minmax(0, 1fr);
    justify-self: stretch;
    padding: var(--space-100) 0 0;
    text-align: left;
  }

  .thread-summary :global(svg) {
    grid-row: 1 / span 2;
    margin-block-start: var(--space-050);
  }

  .thread-summary.no-summary {
    justify-self: end;
    padding: var(--space-100);
  }

  .thread-summary.no-summary :global(svg) {
    grid-row: auto;
    margin: 0;
  }

  .thread-summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .thread-count {
    font-weight: var(--font-weight-medium);
  }

  .thread-summary:hover .thread-count {
    text-decoration: underline;
  }

  .thread-latest {
    -webkit-box-orient: vertical;
    color: var(--surface-var-on-container);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    min-width: 0;
    overflow: hidden;
  }

  li:is(:hover, :focus-within) {
    background: var(--surface-container-hover);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
  }

  .thread-root {
    cursor: pointer;
    min-width: 0;
    width: 100%;
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
