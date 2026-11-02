<script lang="ts">
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import CalendarPage from '#lib/features/calendar/CalendarPage.svelte';
  import RoomPage from '#lib/features/room/RoomPage.svelte';
  import { setNativeOpenConversation } from '#lib/platform/native-notifications.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';

  import ForumPage from './ForumPage.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();
  const appLayout = new AppLayout();

  let roomId = $derived(page.params.roomId ?? '');
  let room = $derived(findRoomByPathId(roomList.rooms, roomId));
  let eventTimeline = $derived(page.url.searchParams.get('timeline') === 'events');
  let roomTimeline = $derived(
    eventTimeline || page.url.searchParams.has('event') || Boolean(page.state.notified)
  );
  let userId = $derived(core.session?.user_id ?? null);
  let openRoomId = $derived(appLayout.drawerCovers(page.state) ? null : (room?.room_id ?? null));

  $effect(() => {
    void setNativeOpenConversation(userId, openRoomId).catch(conversationNotSet);
    return () => {
      void setNativeOpenConversation(null, null).catch(conversationNotSet);
    };
  });

  function conversationNotSet(error: unknown): void {
    console.debug('[sable notifications] open conversation not set', error);
  }
</script>

{#if !roomTimeline && room?.room_kind === 'forum'}
  <ForumPage {roomId} />
{:else if !roomTimeline && room?.room_kind === 'calendar'}
  <CalendarPage {roomId} />
{:else}
  <RoomPage />
{/if}
