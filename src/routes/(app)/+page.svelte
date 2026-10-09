<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { takeAfterLogin } from '#lib/auth/after-login.js';
  import { hasPendingSetup } from '#lib/features/auth/setup/setup-record.js';
  import { readText } from '#lib/platform/local-json.js';
  import { lastRoomId } from '#lib/rooms/last-room.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  const core = useCoreClient();
  const roomList = useRoomList();
  let requestedPath: string | undefined;
  let redirected = false;

  $effect(() => {
    const session = core.session;
    if (redirected || core.status !== 'ready' || !session) return;
    if (hasPendingSetup({ getItem: readText }, session.user_id, session.device_id)) return;

    requestedPath ??= takeAfterLogin('');
    const savedRoomId = preferences.restoreLastRoom ? lastRoomId(session.account_id) : null;
    if (!requestedPath && savedRoomId && !roomList.settled) return;
    const room = roomList.byId(savedRoomId);
    const target =
      room?.state === 'joined' && !room.is_space && !room.is_tombstoned
        ? roomSectionPath(roomList.rooms, room.room_id)
        : resolve('/(app)/rooms');
    redirected = true;
    void goto(requestedPath || target, { replace: true });
  });
</script>
