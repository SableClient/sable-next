<script lang="ts">
  import { page } from '$app/state';
  import { findRoomByPathId, useRoomList } from '$lib/rooms/room-list.svelte';
  import RoutePlaceholder from '$lib/ui/RoutePlaceholder.svelte';

  const roomList = useRoomList();
  let space = $derived(findRoomByPathId(roomList.rooms, page.params.spaceId));
</script>

<RoutePlaceholder title={space?.name ?? page.params.spaceId} />
