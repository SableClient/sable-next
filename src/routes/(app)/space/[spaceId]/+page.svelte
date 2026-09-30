<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { savedSpacePaths, spaceIndexRedirect } from '#lib/features/sidebar/space-paths.js';
  import { findRoomByPathId, roomPathParam, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import RoutePlaceholder from '#lib/ui/RoutePlaceholder.svelte';

  const roomList = useRoomList();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let space = $derived(findRoomByPathId(roomList.rooms, page.params.spaceId));
  let spaceId = $derived(space?.room_id ?? null);

  $effect(() => {
    if (!appLayout.matches || spaceId === null) return;

    const target = untrack(() => {
      if (!space) return null;
      const param = roomPathParam(space);
      return spaceIndexRedirect(
        resolve('/(app)/space/[spaceId]', { spaceId: param }),
        savedSpacePaths()[space.room_id],
        resolve('/(app)/space/[spaceId]/lobby', { spaceId: param }),
        (pathId) => findRoomByPathId(roomList.rooms, pathId)?.state === 'joined'
      );
    });
    if (target !== null) void goto(target, { replaceState: true });
  });
</script>

{#if !appLayout.matches || spaceId === null}
  <RoutePlaceholder title={space?.name ?? page.params.spaceId} />
{/if}
