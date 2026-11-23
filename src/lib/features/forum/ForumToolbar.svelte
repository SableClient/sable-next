<script lang="ts">
  import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUpIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import RowsIcon from 'phosphor-svelte/lib/RowsIcon';

  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SearchField from '#lib/ui/primitives/SearchField.svelte';
  import { isComposingKey } from '#lib/ui/shortcuts/binding.js';

  import type { ForumSort, ForumView } from './forum-threads';

  interface Props {
    query: string;
    view: ForumView;
    onView: (view: ForumView) => void;
    onSubmit: () => void;
    onCreate?: () => void;
  }

  let { query = $bindable(), view, onView, onSubmit, onCreate }: Props = $props();

  let sorts = $derived<{ value: ForumSort; label: string }[]>([
    { value: 'active', label: i18n.t('forum.sortActive') },
    { value: 'created', label: i18n.t('forum.sortCreated') },
    { value: 'votes', label: i18n.t('forum.sortVotes') },
  ]);
  let sortLabel = $derived(sorts.find((sort) => sort.value === view.sort)?.label ?? '');
  let gallery = $derived(view.layout === 'gallery');
</script>

<div class="forum-toolbar">
  <SearchField
    bind:value={query}
    label={onCreate ? i18n.t('forum.searchOrCreate') : i18n.t('forum.search')}
    onkeydown={(event) => {
      if (event.key === 'Enter' && !isComposingKey(event)) onSubmit();
    }}
  />
  <ActionMenu label={i18n.t('forum.sortBy')}>
    {#snippet trigger({ props })}
      <Button
        {...props}
        variant="secondary"
        aria-label={i18n.t('forum.sortCurrent', { sort: sortLabel })}
      >
        <ArrowsDownUpIcon aria-hidden="true" />
        <span class="forum-toolbar-label">{sortLabel}</span>
      </Button>
    {/snippet}
    {#each sorts as sort (sort.value)}
      <ActionMenuItem
        checked={view.sort === sort.value}
        onSelect={() => onView({ ...view, sort: sort.value })}
      >
        <span class="menu-check">
          {#if view.sort === sort.value}<CheckIcon aria-hidden="true" />{/if}
        </span>
        {sort.label}
      </ActionMenuItem>
    {/each}
  </ActionMenu>
  <Button
    variant="secondary"
    aria-label={gallery ? i18n.t('forum.viewList') : i18n.t('forum.viewGallery')}
    onclick={() => onView({ ...view, layout: gallery ? 'list' : 'gallery' })}
  >
    {#if gallery}<RowsIcon aria-hidden="true" />{:else}<GridFourIcon aria-hidden="true" />{/if}
  </Button>
  {#if onCreate}
    <Button variant="primary" aria-label={i18n.t('forum.newThread')} onclick={onCreate}>
      <PlusIcon aria-hidden="true" />
      <span class="forum-toolbar-label">{i18n.t('forum.newThread')}</span>
    </Button>
  {/if}
</div>

<style>
  .forum-toolbar {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-200);
    padding: var(--space-400) var(--space-400) var(--space-200);
  }

  .forum-toolbar :global(.search-field) {
    flex: 1 1 auto;
    width: auto;
  }

  @media (width < 30rem) {
    .forum-toolbar-label {
      display: none;
    }
  }
</style>
