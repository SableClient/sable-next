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
  <SpaceLobby {space} />
</main>

<style>
  .lobby-page {
    margin: 0 auto;
    max-width: 52rem;
    overflow: auto;
    padding: var(--page-gutter);
    width: 100%;
  }
</style>
