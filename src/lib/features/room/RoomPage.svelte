<script lang="ts">
  import { page } from '$app/state';

  import { findRoomByPathId, useRoomList } from '$lib/rooms/room-list.svelte';

  import JoinBeforeNavigate from './JoinBeforeNavigate.svelte';
  import RoomView from './RoomView.svelte';

  const roomList = useRoomList();

  let roomId = $derived(page.params.roomId ?? '');
  let eventId = $derived(page.url.searchParams.get('event'));
  let joined = $derived(findRoomByPathId(roomList.rooms, roomId) !== undefined);

  /* An empty room list means "not loaded yet" as much as "not a member", and
     only the first justifies withholding the timeline. */
  let listed = $state(false);
  $effect(() => {
    void roomList.start().then(() => (listed = true));
  });
</script>

{#if joined || !listed}
  <RoomView {roomId} {eventId} />
{:else}
  <JoinBeforeNavigate {roomId} {eventId} via={page.url.searchParams.getAll('via')} />
{/if}
