<script lang="ts">
  import { page } from '$app/state';

  import RoomPage from '#lib/features/room/RoomPage.svelte';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';

  import { FORUM_ROOM_TYPE } from './forum-detection.js';
  import ForumPage from './ForumPage.svelte';

  const roomList = useRoomList();

  let roomId = $derived(page.params.roomId ?? '');
  let room = $derived(findRoomByPathId(roomList.rooms, roomId));
  let isForum = $derived(room?.room_type === FORUM_ROOM_TYPE);
</script>

{#if isForum}
  <ForumPage {roomId} />
{:else}
  <RoomPage />
{/if}
