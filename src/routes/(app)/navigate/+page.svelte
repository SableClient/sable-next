<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';

  import type { RoomSummary } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import RoomJumpList from '#lib/ui/shortcuts/RoomJumpList.svelte';

  const roomList = useRoomList();

  function select(room: RoomSummary): void {
    void goto(roomSectionPath(roomList.rooms, room.room_id));
  }

  function back(): void {
    void goto(resolve('/(app)/rooms'));
  }
</script>

<AppPageShell class="navigate-page" title={$i18n.t('nav.navigate')} density="compact">
  <RoomJumpList onSelect={select} onClose={back} />
</AppPageShell>

<style>
  :global(.app-page-shell.navigate-page) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  :global(.navigate-page .jump-list) {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  :global(.navigate-page .jump-list ul) {
    align-content: start;
    flex: 1;
    max-height: none;
    min-height: 0;
  }
</style>
