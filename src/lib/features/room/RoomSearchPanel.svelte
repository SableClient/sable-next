<script lang="ts">
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';

  import { i18n } from '#lib/i18n.js';

  import SearchView from '../search/SearchView.svelte';
  import RoomSidePanel from './RoomSidePanel.svelte';

  interface Props {
    query: string;
    modal?: boolean;
    onClose: () => void;
  }

  let { query, modal = false, onClose }: Props = $props();
</script>

<RoomSidePanel
  title={i18n.t('common.searchMessages')}
  closeLabel={i18n.t('search.close')}
  resizeLabel={i18n.t('search.resize')}
  widthKey="sable-room-search-width"
  {modal}
  {onClose}
>
  {#snippet icon()}
    <MagnifyingGlassIcon aria-hidden="true" />
  {/snippet}
  <SearchView panel initialQuery={query} />
</RoomSidePanel>
