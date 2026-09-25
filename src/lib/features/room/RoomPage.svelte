<script lang="ts">
  import type { RoomSummary } from '#src/generated/protocol';
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';

  import JoinBeforeNavigate from './JoinBeforeNavigate.svelte';
  import RoomView from './RoomView.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();

  let roomId = $derived(page.params.roomId ?? '');
  let eventId = $derived(page.url.searchParams.get('event'));
  let notifiedEventId = $derived(page.state.notified ?? null);
  let joined = $derived(findRoomByPathId(roomList.rooms, roomId) !== undefined);

  /* An empty room list means "not loaded yet" as much as "not a member", and
     only the first justifies withholding the timeline. */
  let listed = $state(false);
  $effect(() => {
    void roomList.start().then(() => (listed = true));
  });

  let unlisted = $state.raw<RoomSummary | null>(null);
  let unlistedRoom = $derived(unlisted?.room_id === roomId ? unlisted : undefined);
  $effect(() => {
    const id = roomId;
    unlisted = null;
    if (!listed || joined || !id.startsWith('!')) return;

    let current = true;
    core.commands
      .roomSummary(id)
      .then((room) => {
        if (current && room.state === 'joined') unlisted = room;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] no unlisted room', error);
      });
    return () => {
      current = false;
    };
  });
</script>

{#if joined || !listed || unlistedRoom}
  <RoomView {roomId} {eventId} {notifiedEventId} room={unlistedRoom} />
{:else}
  <JoinBeforeNavigate {roomId} {eventId} via={page.url.searchParams.getAll('via')} />
{/if}
