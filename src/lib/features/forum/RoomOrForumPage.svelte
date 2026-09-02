<script lang="ts">
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import RoomPage from '#lib/features/room/RoomPage.svelte';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';

  import { isForumRoomType } from './forum-detection.js';
  import ForumPage from './ForumPage.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();

  let roomId = $derived(page.params.roomId ?? '');
  let joined = $derived(findRoomByPathId(roomList.rooms, roomId) !== undefined);

  let isForum = $state(false);
  let checkedRoomId = $state<string | null>(null);

  $effect(() => {
    const target = roomId;
    if (!joined) {
      checkedRoomId = null;
      return;
    }

    let cancelled = false;
    core.commands
      .roomStateEvent(target, 'm.room.create', '')
      .then((content) => {
        if (cancelled) return;
        isForum = isForumRoomType(content);
        checkedRoomId = target;
      })
      .catch(() => {
        if (cancelled) return;
        isForum = false;
        checkedRoomId = target;
      });

    return () => {
      cancelled = true;
    };
  });
</script>

{#if !joined}
  <RoomPage />
{:else if checkedRoomId === roomId && isForum}
  <ForumPage {roomId} />
{:else if checkedRoomId === roomId}
  <RoomPage />
{/if}
