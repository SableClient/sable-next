<script lang="ts">
  import type { RoomSummary } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { untrack } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { findRoomByPathId, roomPathParam, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';

  import JoinBeforeNavigate from './discovery/JoinBeforeNavigate.svelte';
  import RoomView from './RoomView.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  let roomId = $derived(page.params.roomId ?? '');
  let eventId = $derived(page.url.searchParams.get('event'));
  let notifiedEventId = $derived(page.state.notified ?? null);
  let listedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let joined = $derived(listedRoom !== undefined);

  let mountedRoomId = $state(untrack(() => (appLayout.matches ? roomId : null)));
  $effect(() => {
    const id = roomId;
    if (appLayout.matches) {
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

  /* An empty room list means "not loaded yet" as much as "not a member", and
     only the first justifies withholding the timeline. */
  let listed = $state(false);
  $effect(() => {
    void roomList
      .start()
      .then(() => (listed = true))
      .catch(() => {});
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

  let resolvedRoom = $derived(listedRoom ?? unlistedRoom);
  let space = $derived(resolvedRoom?.is_space ? resolvedRoom : null);
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

{#if (space === null || eventTimeline) && mountedRoomId === roomId}
  {#if joined || unlistedRoom || (!listed && roomId.startsWith('!'))}
    <RoomView {roomId} {eventId} {notifiedEventId} room={unlistedRoom} />
  {:else if listed}
    <JoinBeforeNavigate {roomId} {eventId} via={page.url.searchParams.getAll('via')} />
  {/if}
{/if}
