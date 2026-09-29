<script lang="ts">
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.js';
  import { untrack } from 'svelte';

  import type { RoomSummary } from '#src/generated/protocol';

  import RoomOptionsMenu from './RoomOptionsMenu.svelte';

  interface Props {
    core: CoreClient;
    room: RoomSummary;
    rooms: RoomSummary[];
    registerRefresh: (refresh: () => void) => void;
  }

  let { core, room, rooms, registerRefresh }: Props = $props();
  const roomList = untrack(() => new RoomList(core));
  roomList.rooms = untrack(() => rooms);

  provideCoreClient(untrack(() => core));
  provideRoomList(roomList);

  untrack(() =>
    registerRefresh(() => {
      roomList.rooms = [...roomList.rooms];
    })
  );
</script>

<RoomOptionsMenu {room} onSettings={() => {}} onLeave={() => {}} />
