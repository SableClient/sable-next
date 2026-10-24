<script lang="ts">
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.js';
  import { FakeRuntime, roomsView } from '#lib/test-support/fake-runtime.js';
  import { untrack } from 'svelte';

  import type { RoomListItemView } from '#src/generated/protocol';

  import RoomOptionsMenu from './RoomOptionsMenu.svelte';

  interface Props {
    core: CoreClient;
    room: RoomListItemView;
    rooms: RoomListItemView[];
    registerRefresh: (refresh: () => void) => void;
  }

  let { core, room, rooms, registerRefresh }: Props = $props();
  const runtime = untrack(() => new FakeRuntime({ rooms: roomsView(rooms) }));
  const roomList = new RoomList(() => runtime.client());
  void roomList.start();

  provideCoreClient(untrack(() => core));
  provideRoomList(roomList);

  untrack(() =>
    registerRefresh(() => {
      runtime.set('rooms', roomsView([...roomList.rooms]));
    })
  );
</script>

<RoomOptionsMenu {room} onSettings={() => {}} onLeave={() => {}} />
