<script lang="ts">
  import { onMount } from 'svelte';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import { PanelWidth, remFromPixels } from '#lib/ui/panel-width.svelte.js';

  import SearchView from '../search/SearchView.svelte';

  interface Props {
    query: string;
    onClose: () => void;
  }

  let { query, onClose }: Props = $props();

  const panelWidth = new PanelWidth('sable-room-search-width', 26, 16, 40);
  onMount(() => panelWidth.restore());
</script>

<aside
  class="room-search"
  aria-label={$i18n.t('common.searchMessages')}
  style:width={`${panelWidth.width}rem`}
>
  <ResizeHandle
    value={panelWidth.width}
    min={panelWidth.min}
    max={panelWidth.max}
    label={$i18n.t('search.resize')}
    grow="left"
    step={1}
    fromPixels={remFromPixels}
    onResize={(next) => panelWidth.resize(next)}
    onCommit={() => panelWidth.commit()}
  />
  <PanelHeader title={$i18n.t('common.searchMessages')}>
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
    color: var(--bg-on-container);
    display: grid;
    flex: 0 0 auto;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
    position: relative;
    width: 26rem;
  }

  .room-search :global(.resize-handle) {
    left: -0.25rem;
    z-index: 1;
  }

  .room-search-body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--space-300);
  }
</style>
