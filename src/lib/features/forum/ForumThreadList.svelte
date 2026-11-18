<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { MAX_PINNED, type ForumLayout, type ForumThread } from './forum-threads';
  import type { ForumThreadCallbacks } from './forum-thread-callbacks';
  import ForumThreadItem from './ForumThreadItem.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import { whenVisible } from '#lib/ui/when-visible.js';

  interface Props {
    threads: readonly ForumThread[];
    loading: boolean;
    failed?: boolean;
    onRetry?: () => void;
    canLoadMore: boolean;
    callbacks: ForumThreadCallbacks;
    canDelete: (thread: ForumThread) => boolean;
    roomId: string;
    onLoadMore: () => void;
    isPinned?: (eventId: string) => boolean;
    layout?: ForumLayout;
    filtered?: boolean;
    onCreate?: () => void;
  }

  let {
    threads,
    loading,
    failed = false,
    onRetry,
    canLoadMore,
    callbacks,
    canDelete,
    roomId,
    onLoadMore,
    isPinned = () => false,
    layout = 'list',
    filtered = false,
    onCreate,
  }: Props = $props();

  let pinnedThreads = $derived(
    threads.filter((thread) => isPinned(thread.eventId)).slice(0, MAX_PINNED)
  );
  let pinnedIds = $derived(new Set(pinnedThreads.map((thread) => thread.id)));
  let otherThreads = $derived(threads.filter((thread) => !pinnedIds.has(thread.id)));
</script>

<div class="forum-thread-list" {@attach scrollHint}>
  {#snippet failure()}
    <div class="forum-thread-list-more" role="alert">
      <span>{i18n.t('timeline.loadFailed')}</span>
      <Button variant="secondary" size="small" onclick={onRetry}>{i18n.t('common.tryAgain')}</Button
      >
    </div>
  {/snippet}
  {#if failed && threads.length === 0}
    {@render failure()}
  {/if}
  {#if threads.length === 0 && loading && !failed}
    <div class={['forum-threads', layout]} aria-hidden="true">
      {#each { length: 4 }, index (index)}
        <Skeleton class="forum-thread-skeleton" />
      {/each}
    </div>
  {:else if threads.length === 0 && !failed && !(filtered && canLoadMore)}
    <div class="forum-thread-list-empty">
      <p class="forum-thread-list-empty-title">
        {filtered ? i18n.t('forum.noMatches') : i18n.t('forum.empty')}
      </p>
      {#if onCreate}
        {#if !filtered}<p>{i18n.t('forum.newThreadHint')}</p>{/if}
        <Button variant="primary" size="small" onclick={onCreate}>
          {i18n.t('forum.newThread')}
        </Button>
      {/if}
    </div>
  {:else if threads.length > 0}
    {#if pinnedThreads.length > 0}
      <h2 class="forum-threads-heading">{i18n.t('forum.pinned')}</h2>
      <ul class={['forum-threads', layout]} aria-label={i18n.t('forum.pinned')}>
        {#each pinnedThreads as thread (thread.id)}
          <ForumThreadItem
            {thread}
            {...callbacks}
            canDelete={canDelete(thread)}
            {roomId}
            {layout}
            pinned
          />
        {/each}
      </ul>
    {/if}
    {#if pinnedThreads.length > 0 && otherThreads.length > 0}
      <h2 class="forum-threads-heading">{i18n.t('forum.threads')}</h2>
    {/if}
    <ul class={['forum-threads', layout]} aria-label={i18n.t('forum.threads')}>
      {#each otherThreads as thread (thread.id)}
        <ForumThreadItem
          {thread}
          {...callbacks}
          canDelete={canDelete(thread)}
          {roomId}
          {layout}
          pinned={isPinned(thread.eventId)}
        />
      {/each}
    </ul>
  {/if}
  {#if failed && threads.length > 0}
    {@render failure()}
  {:else if !failed && (canLoadMore || loading) && threads.length > 0}
    <div class="forum-thread-list-more">
      <Spinner small label={i18n.t('a11y.loading')} />
    </div>
  {/if}
  {#if canLoadMore && !loading && !failed}
    <div {@attach whenVisible(onLoadMore)}></div>
  {/if}
</div>

<style>
  .forum-thread-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-200) var(--space-400) var(--space-500);
  }

  .forum-threads {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .forum-threads-heading {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-600);
    margin: var(--space-500) 0 var(--space-200);
  }

  .forum-threads-heading:first-child {
    margin-top: 0;
  }

  .forum-threads.gallery {
    gap: var(--space-300);
    grid-template-columns: repeat(auto-fill, minmax(min(15rem, 100%), 1fr));
  }

  .forum-threads :global(.forum-thread-skeleton) {
    border-radius: var(--radii-400);
    height: 5.5rem;
  }

  .forum-threads.gallery :global(.forum-thread-skeleton) {
    height: 14rem;
  }

  .forum-thread-list-empty {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    margin: 0 auto;
    max-width: 28rem;
    padding: var(--space-700) var(--space-400);
    text-align: center;
  }

  .forum-thread-list-empty p {
    margin: 0;
  }

  .forum-thread-list-empty-title {
    color: var(--surface-on-container);
    font-size: var(--font-size-subheading);
    font-weight: var(--font-weight-600);
  }

  .forum-thread-list-empty :global(.btn) {
    margin-top: var(--space-200);
  }

  .forum-thread-list-more {
    display: flex;
    justify-content: center;
    padding: var(--space-400);
  }
</style>
