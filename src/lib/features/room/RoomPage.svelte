<script lang="ts">
  import { page } from '$app/state';

  import { findRoomByPathId, useRoomList } from '$lib/rooms/room-list.svelte';

  import JoinBeforeNavigate from './JoinBeforeNavigate.svelte';
  import RoomView from './RoomView.svelte';

  const roomList = useRoomList();

  /* Opening settings shallow-rewrites the URL to /settings/<section>, which drops
     `?event=`; re-reading it then would restart the timeline at the present. */
  let held = readTarget();
  let target = $derived.by(() => {
    if (page.state.settings === undefined) held = readTarget();
    return held;
  });

  function readTarget(): { roomId: string; eventId: string | null; via: string[] } {
    return {
      roomId: page.params.roomId ?? '',
      eventId: page.url.searchParams.get('event'),
      via: page.url.searchParams.getAll('via'),
    };
  }

  let roomId = $derived(target.roomId);
  let eventId = $derived(target.eventId);
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
  <JoinBeforeNavigate {roomId} {eventId} via={target.via} />
{/if}
