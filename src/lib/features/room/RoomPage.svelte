<script lang="ts">
  import type { RoomListItemView } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import { findRoomByPathId, roomPathParam, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';

  import JoinBeforeNavigate from './discovery/JoinBeforeNavigate.svelte';
  import RoomView from './RoomView.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();
  const appLayout = new AppLayout();

  let roomId = $derived(page.params.roomId ?? '');
  let eventId = $derived(page.url.searchParams.get('event'));
  let notifiedEventId = $derived(page.state.notified ?? null);
  let listedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let joined = $derived(listedRoom?.state === 'joined');

  let mountedRoomId = $state<string | null>(null);
  $effect(() => {
    const id = roomId;
    if (appLayout.current) {
      mountedRoomId = id;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        mountedRoomId = id;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  });

  let roomMounted = $derived(appLayout.current || mountedRoomId === roomId);

  let listed = $derived(roomList.settled);

  let unlisted = $state.raw<RoomListItemView | null>(null);
  let unlistedRoom = $derived(
    unlisted?.room_id === roomId && unlisted?.state === 'joined' ? unlisted : undefined
  );
  $effect(() => {
    const id = roomId;
    unlisted = null;
    if (!listed || joined || !id.startsWith('!')) return;

    let current = true;
    core.rpc.rooms
      .listItem({ room_id: id })
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

  let resolvedRoom = $derived(listedRoom ?? unlistedRoom);
  let space = $derived(resolvedRoom?.room_kind === 'space' ? resolvedRoom : null);
  let eventTimeline = $derived(page.url.searchParams.get('timeline') === 'events');
  $effect(() => {
    if (!space || eventTimeline) return;
    void goto(
      resolve('/(app)/space/[spaceId]/lobby', { spaceId: roomPathParam(space, roomList.rooms) }),
      {
        replace: true,
      }
    );
  });
</script>

{#if (space === null || eventTimeline) && roomMounted}
  {#if joined || unlistedRoom || (!listed && roomId.startsWith('!'))}
    <RoomView {roomId} {eventId} {notifiedEventId} room={unlistedRoom} />
  {:else if listed}
    <JoinBeforeNavigate
      {roomId}
      {eventId}
      via={page.url.searchParams.getAll('via')}
      membership={listedRoom?.state}
    />
  {/if}
{/if}
