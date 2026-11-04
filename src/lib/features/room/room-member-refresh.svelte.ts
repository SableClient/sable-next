import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';

/** Each refresh reads every member from the store, so a burst of changes refreshes once. */
const MEMBER_REFRESH_DELAY_MS = 500;

export function refreshRoomMembers(
  core: Pick<CoreClient, 'rpc' | 'onProfileChanged' | 'subscribeEvents'>,
  memberLoader: Pick<RoomMemberLoader, 'refresh' | 'members'>,
  resolvedRoomId: () => string
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = () => {
    timer ??= setTimeout(() => {
      timer = null;
      void memberLoader.refresh(resolvedRoomId(), (roomId) =>
        core.rpc.members.list({ room_id: roomId, memberships: [] })
      );
    }, MEMBER_REFRESH_DELAY_MS);
  };

  $effect(() => () => {
    if (timer !== null) clearTimeout(timer);
  });

  $effect(() =>
    core.subscribeEvents((event) => {
      if (event.type === 'members_changed' && event.room_id === resolvedRoomId()) refresh();
    })
  );

  $effect(() =>
    core.onProfileChanged((userId) => {
      if (memberLoader.members.some((member) => member.user_id === userId)) refresh();
    })
  );
}
