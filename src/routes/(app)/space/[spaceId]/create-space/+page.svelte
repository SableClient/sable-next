<script lang="ts">
  import { page } from '$app/state';

  import CreateRoomForm from '#lib/features/room/CreateRoomForm.svelte';
  import { i18n } from '#lib/i18n.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';

  const roomList = useRoomList();
  let space = $derived(findRoomByPathId(roomList.rooms, page.params.spaceId) ?? null);
</script>

<AppPageShell
  eyebrow={space?.name ?? undefined}
  title={$i18n.t('room.createSubspaceTitle')}
  description={$i18n.t('room.createSpaceDescription')}
>
  <CreateRoomForm mode="space" parentSpaceId={space?.room_id ?? null} />
</AppPageShell>
