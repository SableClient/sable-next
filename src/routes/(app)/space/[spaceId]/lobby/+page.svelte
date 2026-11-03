<script lang="ts">
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import { page } from '$app/state';

  import JoinBeforeNavigate from '#lib/features/room/discovery/JoinBeforeNavigate.svelte';
  import SpaceLobby from '#lib/features/room/spaces/SpaceLobby.svelte';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { i18n } from '#lib/i18n.js';

  const roomList = useRoomList();
  let spaceId = $derived(page.params.spaceId ?? '');
  let space = $derived(findRoomByPathId(roomList.rooms, spaceId) ?? null);
</script>

<PageTitle title={space?.name ?? i18n.t('nav.lobby')} />

<main class="lobby-page">
  <div class="lobby-column">
    {#if (space !== null && space.state === 'joined') || !roomList.settled}
      <SpaceLobby {space} />
    {:else}
      <JoinBeforeNavigate
        roomId={spaceId}
        via={page.url.searchParams.getAll('via')}
        membership={space?.state}
      />
    {/if}
  </div>
</main>

<style>
  .lobby-page {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }

  .lobby-column {
    margin: 0 auto;
    max-width: 52rem;
    padding: var(--page-gutter);
    width: 100%;
  }
</style>
