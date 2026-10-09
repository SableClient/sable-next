<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import type { ForumThread } from './forum-threads';
  import ForumThreadItem from './ForumThreadItem.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  const MAX_PINNED = 3;

  interface Props {
    threads: readonly ForumThread[];
    loading: boolean;
    canLoadMore: boolean;
    onOpen: (eventId: string) => void;
    canDelete: (thread: ForumThread) => boolean;
    onEdit?: (thread: ForumThread) => void;
    onDelete: (eventId: string, reason: string | null) => void;
    roomId: string;
    onReact?: (eventId: string, key: string) => void;
    loadImagePacks: (roomId: string) => Promise<import('#src/generated/protocol').ImagePackView[]>;
    onCopyLink: (eventId: string) => void;
    onLoadMore: () => void;
    isPinned?: (eventId: string) => boolean;
    onPin?: (eventId: string) => void;
  }

  let {
    threads,
    loading,
    canLoadMore,
    onOpen,
    canDelete,
    onEdit,
    onDelete,
    roomId,
    onReact,
    loadImagePacks,
    onCopyLink,
    onLoadMore,
    isPinned = () => false,
    onPin,
  }: Props = $props();

  let pinnedThreads = $derived(
    threads.filter((thread) => isPinned(thread.eventId)).slice(0, MAX_PINNED)
  );
  let pinnedIds = $derived(new Set(pinnedThreads.map((thread) => thread.id)));
  let otherThreads = $derived(threads.filter((thread) => !pinnedIds.has(thread.id)));
</script>

<div class="forum-thread-list" {@attach scrollHint}>
  {#if threads.length === 0 && !loading}
    <p class="forum-thread-list-empty">{$i18n.t('forum.empty')}</p>
  {:else if threads.length > 0}
    {#if pinnedThreads.length > 0}
      <ul aria-label={$i18n.t('forum.pinned')}>
        {#each pinnedThreads as thread (thread.id)}
          <ForumThreadItem
            {thread}
            {onOpen}
            canDelete={canDelete(thread)}
            {onEdit}
            {onDelete}
            {roomId}
            {onReact}
            {loadImagePacks}
            {onCopyLink}
            {onPin}
            pinned
          />
        {/each}
      </ul>
    {/if}
    <ul aria-label={$i18n.t('forum.threads')}>
      {#each otherThreads as thread (thread.id)}
        <ForumThreadItem
          {thread}
          {onOpen}
          canDelete={canDelete(thread)}
          {onEdit}
          {onDelete}
          {roomId}
          {onReact}
          {loadImagePacks}
          {onCopyLink}
          {onPin}
          pinned={isPinned(thread.eventId)}
        />
      {/each}
    </ul>
  {/if}
  {#if canLoadMore}
    <div class="forum-thread-list-more">
      <Button variant="ghost" size="small" onclick={onLoadMore} {loading}>
        {$i18n.t('forum.loadMore')}
      </Button>
    </div>
  {:else if loading}
    <div class="forum-thread-list-more">
      <Spinner small label={$i18n.t('a11y.loading')} />
    </div>
  {/if}
</div>

<style>
  .forum-thread-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-200) var(--space-400) var(--space-500);
  }

  .forum-thread-list ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .forum-thread-list-empty {
    color: var(--surface-var-on-container);
    padding: var(--space-500);
    text-align: center;
  }

  .forum-thread-list-more {
    display: flex;
    justify-content: center;
    padding: var(--space-400);
  }
</style>
