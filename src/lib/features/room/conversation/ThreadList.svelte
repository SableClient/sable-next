<script lang="ts">
  import { onMount } from 'svelte';
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import ThreadIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import { PanelWidth, remFromPixels } from '#lib/ui/panel-width.svelte.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { stripReplyFallback } from '../members/members.js';
  import MessagePreview from '../messages/MessagePreview.svelte';
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
  let roots = $state.raw<TimelineItemView[]>([]);
  let nextBatch = $state<string | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let generation = 0;

  async function load(from: string | null): Promise<void> {
    const run = ++generation;
    loading = true;
    failed = false;
    try {
      const page = await core.commands.listThreads(roomId, from);
      if (run !== generation) return;
      roots = from === null ? page.roots : [...roots, ...page.roots];
      nextBatch = page.next_batch;
    } catch (error) {
      console.debug('[sable room] threads unavailable', error);
      if (run === generation) failed = true;
    } finally {
      if (run === generation) loading = false;
    }
  }

  $effect(() => {
    void roomId;
    roots = [];
    nextBatch = null;
    void load(null);
  });

  const panelWidth = new PanelWidth('sable-thread-list-width', 22, 16, 40);
  onMount(() => panelWidth.restore());
</script>

{#snippet body()}
  <aside
    class={['thread-list', { modal }]}
    aria-label={$i18n.t('timeline.threadsTitle')}
    style:width={modal ? null : `${panelWidth.width}rem`}
  >
    {#if !modal}
      <ResizeHandle
        value={panelWidth.width}
        min={panelWidth.min}
        max={panelWidth.max}
        label={$i18n.t('timeline.threadsResize')}
        grow="left"
        step={1}
        fromPixels={remFromPixels}
        onResize={(next) => panelWidth.resize(next)}
        onCommit={() => panelWidth.commit()}
      />
    {/if}
    <PanelHeader class="thread-list-header" title={$i18n.t('timeline.threadsTitle')}>
      {#snippet prefix()}
        <ChatsIcon aria-hidden="true" />
      {/snippet}
      {#snippet suffix()}
        <PanelHeaderButton label={$i18n.t('timeline.threadsClose')} onclick={onClose}>
          <XIcon />
        </PanelHeaderButton>
      {/snippet}
    </PanelHeader>

    <div class="thread-list-body">
      {#if roots.length > 0}
        <ul>
          {#each roots as root (root.id)}
            {@const rootId = root.event_id ?? root.id}
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
              <button
                type="button"
                class="thread-summary"
                class:no-summary={!root.thread_summary}
                aria-label={root.thread_summary ? undefined : $i18n.t('timeline.threadOpen')}
                title={root.thread_summary ? undefined : $i18n.t('timeline.threadOpen')}
                onclick={() => {
                  onOpenThread(rootId);
                }}
              >
                <ThreadIcon size={14} aria-hidden="true" />
                {#if root.thread_summary}
                  <span class="thread-count">
                    {$i18n.t('timeline.threadReplies', { count: root.thread_summary.num_replies })}
                  </span>
                {/if}
                {#if root.thread_summary?.latest_body}
                  <span class="thread-latest"
                    >{stripReplyFallback(root.thread_summary.latest_body, null)}</span
                  >
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {:else if !loading && !failed}
        <p class="thread-list-status">{$i18n.t('timeline.threadsEmpty')}</p>
      {/if}

      {#if failed}
        <p class="thread-list-status" role="alert">{$i18n.t('timeline.threadsFailed')}</p>
      {/if}
      {#if loading}
        <div class="thread-list-loading"><Spinner small /></div>
      {:else if nextBatch !== null || failed}
        <div class="thread-list-more">
          <Button size="small" variant="secondary" onclick={() => void load(nextBatch)}>
            {failed ? $i18n.t('timeline.threadsRetry') : $i18n.t('timeline.threadsLoadMore')}
          </Button>
        </div>
      {/if}
    </div>
  </aside>
{/snippet}

{#if modal}
  <DialogFrame
    open
    onOpenChange={(open: boolean) => {
      if (!open) onClose();
    }}
    variant="drawer"
    label={$i18n.t('timeline.threadsTitle')}
  >
    {@render body()}
  </DialogFrame>
{:else}
  {@render body()}
{/if}

<style>
  .thread-list {
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    border-left: var(--border-width) solid var(--bg-container-line);
    color: var(--bg-on-container);
    display: grid;
    flex: 0 0 auto;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
    position: relative;
    width: 22rem;
  }

  .thread-list :global(.resize-handle) {
    left: -0.25rem;
    z-index: 1;
  }

  .thread-list.modal {
    border-left: none;
    height: 100%;
    width: 100%;
  }

  .thread-list-body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

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
