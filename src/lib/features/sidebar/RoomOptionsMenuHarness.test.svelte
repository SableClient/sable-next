<script lang="ts">
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.js';
  import { untrack } from 'svelte';

  import type { RoomListItemView } from '#src/generated/protocol';

  import { roomSpacesLookup } from '#lib/test-support/room-spaces.js';

  import RoomOptionsMenu from './RoomOptionsMenu.svelte';

  interface Props {
    core: CoreClient;
    room: RoomListItemView;
    rooms: RoomListItemView[];
    quietRoomIds?: string[];
    registerRefresh: (refresh: () => void) => void;
  }

  let { core, room, rooms, quietRoomIds = [], registerRefresh }: Props = $props();
  const roomList = untrack(() => new RoomList(core));
  roomList.rooms = untrack(() => rooms);
  roomList.quietRoomIds = new Set(untrack(() => quietRoomIds));
  Object.assign(roomList, {
    roomSpaces: (roomId: string) => roomSpacesLookup(roomList.rooms)(roomId),
  });

  provideCoreClient(untrack(() => core));
  provideRoomList(roomList);

  untrack(() =>
    registerRefresh(() => {
      roomList.rooms = [...roomList.rooms];
    })
  );
</script>

<RoomOptionsMenu {room} onSettings={() => {}} onLeave={() => {}} />
