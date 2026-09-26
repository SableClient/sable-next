<script lang="ts">
  import { page } from '$app/state';

  import { CALENDAR_ROOM_TYPE } from '#lib/features/calendar/calendar-events.js';
  import CalendarPage from '#lib/features/calendar/CalendarPage.svelte';
  import RoomPage from '#lib/features/room/RoomPage.svelte';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';

  import { FORUM_ROOM_TYPE } from './forum-detection.js';
  import ForumPage from './ForumPage.svelte';

  const roomList = useRoomList();

  let roomId = $derived(page.params.roomId ?? '');
  let room = $derived(findRoomByPathId(roomList.rooms, roomId));
  let isForum = $derived(room?.room_type === FORUM_ROOM_TYPE);
  let isCalendar = $derived(room?.room_type === CALENDAR_ROOM_TYPE);
</script>

{#if isForum}
  <ForumPage {roomId} />
{:else if isCalendar}
  <CalendarPage {roomId} />
{:else}
  <RoomPage />
{/if}
