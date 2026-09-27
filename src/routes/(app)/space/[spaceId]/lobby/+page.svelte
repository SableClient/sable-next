<script lang="ts">
  import { page } from '$app/state';

  import JoinBeforeNavigate from '#lib/features/room/discovery/JoinBeforeNavigate.svelte';
  import SpaceLobby from '#lib/features/room/spaces/SpaceLobby.svelte';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { i18n } from '#lib/i18n.js';

  const roomList = useRoomList();
  let spaceId = $derived(page.params.spaceId ?? '');
  let space = $derived(findRoomByPathId(roomList.rooms, spaceId) ?? null);

  let listed = $state(false);
  $effect(() => {
    void roomList
      .start()
      .then(() => (listed = true))
      .catch(() => {});
  });
</script>

<svelte:head>
  <title>{space?.name ?? $i18n.t('nav.lobby')} - Sable</title>
</svelte:head>

<main class="lobby-page">
  <div class="lobby-column">
    {#if space !== null || !listed}
      <SpaceLobby {space} />
    {:else}
      <JoinBeforeNavigate roomId={spaceId} via={page.url.searchParams.getAll('via')} />
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
