<script lang="ts">
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import RoomBackButton from '#lib/features/room/RoomBackButton.svelte';

  interface Props {
    roomId: string;
    roomName: string;
    roomAvatar: string | null;
    onBack: () => void;
    backUnread?: number;
    onSearch: () => void;
    onEventTimeline?: () => void;
  }

  let {
    roomId,
    roomName,
    roomAvatar,
    onBack,
    backUnread = 0,
    onSearch,
    onEventTimeline,
  }: Props = $props();
</script>

<PanelHeader class="forum-header" title={roomName} titleSize="h1">
  {#snippet prefix()}
    <RoomBackButton {onBack} unread={backUnread} />
    <Avatar class="forum-avatar" id={roomId} src={roomAvatar} name={roomName} size="small" />
  {/snippet}
  {#snippet suffix()}
    {#if onEventTimeline}
      <PanelHeaderButton label={i18n.t('timeline.eventTimeline')} onclick={onEventTimeline}>
        <ListBulletsIcon />
      </PanelHeaderButton>
    {/if}
    <PanelHeaderButton
      class="search-button"
      label={i18n.t('common.searchMessages')}
      onclick={onSearch}
    >
      <MagnifyingGlassIcon />
    </PanelHeaderButton>
  {/snippet}
</PanelHeader>
