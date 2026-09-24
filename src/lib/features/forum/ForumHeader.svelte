<script lang="ts">
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';

  interface Props {
    roomId: string;
    roomName: string;
    roomAvatar: string | null;
    onBack: () => void;
    onSearch: () => void;
  }

  let { roomId, roomName, roomAvatar, onBack, onSearch }: Props = $props();
</script>

<PanelHeader class="forum-header" title={roomName}>
  {#snippet prefix()}
    <PanelHeaderButton class="back-button" label={$i18n.t('timeline.back')} onclick={onBack}>
      <BackIcon />
    </PanelHeaderButton>
    <Avatar class="forum-avatar" id={roomId} src={roomAvatar} name={roomName} size="small" />
  {/snippet}
  {#snippet suffix()}
    <PanelHeaderButton class="search-button" label={$i18n.t('search.open')} onclick={onSearch}>
      <MagnifyingGlassIcon />
    </PanelHeaderButton>
  {/snippet}
</PanelHeader>
