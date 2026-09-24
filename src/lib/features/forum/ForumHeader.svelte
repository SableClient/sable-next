<script lang="ts">
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';

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
    <IconButton
      class="back-button"
      variant="ghost"
      size="small"
      label={$i18n.t('timeline.back')}
      onclick={onBack}
    >
      <BackIcon />
    </IconButton>
    <Avatar class="forum-avatar" id={roomId} src={roomAvatar} name={roomName} size="small" />
  {/snippet}
  {#snippet suffix()}
    <IconButton
      class="search-button"
      variant="ghost"
      size="small"
      label={$i18n.t('search.open')}
      onclick={onSearch}
    >
      <MagnifyingGlassIcon />
    </IconButton>
  {/snippet}
</PanelHeader>
