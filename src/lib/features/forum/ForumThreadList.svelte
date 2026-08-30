<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import type { ForumThread } from './forum-threads';
  import ForumThreadItem from './ForumThreadItem.svelte';

  interface Props {
    threads: readonly ForumThread[];
    loading: boolean;
    canLoadMore: boolean;
    onOpen: (eventId: string) => void;
    onLoadMore: () => void;
  }

  let { threads, loading, canLoadMore, onOpen, onLoadMore }: Props = $props();
</script>

<div class="forum-thread-list">
  {#if threads.length === 0 && !loading}
    <p class="forum-thread-list-empty">{$i18n.t('forum.empty')}</p>
  {:else}
    <ul aria-label={$i18n.t('forum.threads')}>
      {#each threads as thread (thread.id)}
        <ForumThreadItem {thread} {onOpen} />
      {/each}
    </ul>
    {#if canLoadMore}
      <div class="forum-thread-list-more">
        <Button variant="ghost" size="small" onclick={onLoadMore} {loading}>
          {$i18n.t('forum.loadMore')}
        </Button>
      </div>
    {:else if loading}
      <div class="forum-thread-list-more">
        <Spinner small />
      </div>
    {/if}
  {/if}
</div>

<style>
  .forum-thread-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .forum-thread-list ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .forum-thread-list-empty {
    color: var(--sable-surface-var-on-container);
    padding: var(--space-500);
    text-align: center;
  }

  .forum-thread-list-more {
    display: flex;
    justify-content: center;
    padding: var(--space-400);
  }
</style>
