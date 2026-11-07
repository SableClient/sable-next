<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { openingNotification } from '#lib/features/notifications/notification-opening.svelte.js';
  import { takeAfterLogin } from '#lib/auth/after-login.js';
  import { hasPendingSetup } from '#lib/features/auth/setup/setup-record.js';
  import { readText } from '#lib/platform/local-json.js';
  import { lastRoomId, lastRoomSection, restoredRoomPath } from '#lib/rooms/last-room.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  const core = useCoreClient();
  const roomList = useRoomList();
  let requestedPath: string | undefined;
  let redirected = false;

  $effect(() => {
    const session = core.session;
    if (redirected || core.status !== 'ready' || !session) return;
    if (openingNotification()) return;
    if (hasPendingSetup({ getItem: readText }, session.user_id, session.device_id)) return;

    requestedPath ??= takeAfterLogin('');
    const savedRoomId = preferences.restoreLastRoom ? lastRoomId(session.account_id) : null;
    if (!requestedPath && savedRoomId && !roomList.settled) return;
    const room = roomList.byId(savedRoomId);
    const target =
      room?.state === 'joined' && room?.room_kind !== 'space' && !room.is_tombstoned
        ? restoredRoomPath(
            roomList.rooms,
            room.room_id,
            lastRoomSection(session.account_id),
            preferences.showHome
          )
        : preferences.showHome
          ? resolve('/(app)/home')
          : resolve('/(app)/rooms');
    redirected = true;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- takeAfterLogin() and restoredRoomPath() resolve their routes
    void goto(requestedPath || target, { replace: true });
  });
</script>
