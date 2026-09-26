<script lang="ts">
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import MessagePreview from './MessagePreview.svelte';
  import { opensFrom } from './message-preview';

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
</script>

{#snippet body()}
  <aside class={['thread-list', { modal }]} aria-label={$i18n.t('timeline.threadsTitle')}>
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
                <MessagePreview {roomId} eventId={rootId} item={root} {members}>
                  {#snippet fallback()}{/snippet}
                </MessagePreview>
              </div>
              <Button
                size="small"
                variant="ghost"
                class="thread-open"
                onclick={() => {
                  onOpenThread(rootId);
                }}
              >
                {$i18n.t('timeline.threadsOpenRoot')}
              </Button>
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

  li {
    border-radius: var(--radius);
    display: grid;
    justify-items: start;
    padding: 0 var(--space-300) var(--space-200) var(--space-400);
  }

  li:hover {
    background: var(--bg-container-hover);
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
