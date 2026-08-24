<script lang="ts">
  import { page } from '$app/state';

  import SpaceLobby from '#lib/features/room/SpaceLobby.svelte';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';

  const roomList = useRoomList();
  let space = $derived(findRoomByPathId(roomList.rooms, page.params.spaceId) ?? null);
</script>

<svelte:head>
  <title>{space?.name ?? 'Lobby'} - Sable</title>
</svelte:head>

<main class="lobby-page">
  <div class="lobby-column">
    <SpaceLobby {space} />
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
