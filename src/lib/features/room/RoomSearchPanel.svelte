<script lang="ts">
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';

  import SearchView from '../search/SearchView.svelte';

  interface Props {
    query: string;
    onClose: () => void;
  }

  let { query, onClose }: Props = $props();
</script>

<aside class="room-search" aria-label={$i18n.t('search.title')}>
  <PanelHeader title={$i18n.t('search.title')}>
    {#snippet prefix()}
      <MagnifyingGlassIcon aria-hidden="true" />
    {/snippet}
    {#snippet suffix()}
      <PanelHeaderButton label={$i18n.t('search.close')} onclick={onClose}>
        <XIcon />
      </PanelHeaderButton>
    {/snippet}
  </PanelHeader>
  <div class="room-search-body">
    <SearchView panel initialQuery={query} />
  </div>
</aside>

<style>
  .room-search {
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    border-left: var(--border-width) solid var(--bg-container-line);
    display: grid;
    flex: 0 0 auto;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
    width: 26rem;
  }

  .room-search-body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--space-300);
  }
</style>
