<script lang="ts">
  import type { MemberView, ThreadRootView } from '#src/generated/protocol';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { memberName } from './members';
  import { formatMessageTimestamp } from './timeline-format';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onOpenThread: (rootEventId: string) => void;
    onClose: () => void;
  }

  let { roomId, members, modal = false, onOpenThread, onClose }: Props = $props();

  const core = useCoreClient();
  let roots = $state.raw<ThreadRootView[]>([]);
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
</script>

{#snippet body()}
  <aside class={['thread-list', { modal }]} aria-label={$i18n.t('timeline.threadsTitle')}>
    <header class="thread-list-header">
      <div class="thread-list-title">
        <ChatsIcon aria-hidden="true" />
        <h2>{$i18n.t('timeline.threadsTitle')}</h2>
      </div>
      <IconButton
        variant="ghost"
        size="small"
        label={$i18n.t('timeline.threadsClose')}
        onclick={onClose}
      >
        <XIcon />
      </IconButton>
    </header>

    <div class="thread-list-body">
      {#if roots.length > 0}
        <ul>
          {#each roots as root (root.event_id)}
            <li>
              <button
                type="button"
                class="thread-root choice"
                onclick={() => {
                  onOpenThread(root.event_id);
                }}
              >
                <span class="thread-root-meta">
                  <span class="thread-root-sender">{memberName(members, root.sender)}</span>
                  {#if root.timestamp !== null}
                    <time>{formatMessageTimestamp(root.timestamp)}</time>
                  {/if}
                </span>
                <span class="thread-root-body">{root.body}</span>
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
    display: grid;
    flex: 0 0 auto;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
    width: 22rem;
  }

  .thread-list.modal {
    border-left: none;
    height: 100%;
    width: 100%;
  }

  .thread-list-header {
    align-items: center;
    border-bottom: var(--border-width) solid var(--bg-container-line);
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    min-height: var(--header-height);
    padding: 0 var(--space-200) 0 var(--space-400);
  }

  .thread-list-title {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
  }

  .thread-list-header h2 {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .thread-list-body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  ul {
    display: grid;
    list-style: none;
    margin: 0;
    padding: var(--space-200);
  }

  .thread-root {
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-300);
    text-align: start;
    width: 100%;
  }

  .thread-root:hover {
    background: var(--bg-container-hover);
  }

  .thread-root:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .thread-root-meta {
    align-items: baseline;
    display: flex;
    gap: var(--space-200);
    justify-content: space-between;
    min-width: 0;
  }

  .thread-root-sender {
    font-weight: var(--font-weight-medium);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  time {
    color: var(--surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
  }

  .thread-root-body {
    -webkit-box-orient: vertical;
    color: var(--surface-var-on-container);
    display: -webkit-box;
    font-size: var(--font-size-small);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
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
