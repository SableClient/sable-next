<script lang="ts">
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import { onMount } from 'svelte';
  import type { RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { groupsFavourites, setGroupsFavourites } from '#lib/rooms/favourite-grouping.svelte.js';
  import ActionMenuCheckItem from '#lib/ui/primitives/ActionMenuCheckItem.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';

  interface Props {
    activeSpace: RoomListItemView | null;
    favouriteView: string;
    markReadDisabled: boolean;
    onMarkRead: () => void;
    onInvite: (room: RoomListItemView) => void;
    onSettings: (room: RoomListItemView) => void;
    onLeave: (room: RoomListItemView) => void;
  }

  let {
    activeSpace,
    favouriteView,
    markReadDisabled,
    onMarkRead,
    onInvite,
    onSettings,
    onLeave,
  }: Props = $props();

  let groupFavourites = $derived(groupsFavourites(favouriteView));

  const core = useCoreClient();
  let canInvite = $state(false);
  // These items mount with the menu, so the permission is read each time it opens.
  onMount(() => {
    if (!activeSpace) return;
    core.rpc.members.permissions({ room_id: activeSpace.room_id }).then(
      (permissions) => {
        canInvite = permissions.can_invite;
      },
      (error: unknown) => {
        console.debug('[sable room] space permissions unavailable', error);
      }
    );
  });
</script>

<ActionMenuItem disabled={markReadDisabled} onSelect={onMarkRead}>
  <ChecksIcon />
  {i18n.t('common.markAsRead')}
</ActionMenuItem>
<ActionMenuCheckItem
  kind="checkbox"
  closeOnSelect={false}
  checked={groupFavourites}
  label={i18n.t('nav.groupFavourites')}
  onSelect={() => {
    setGroupsFavourites(favouriteView, !groupFavourites);
  }}
/>
{#if activeSpace}
  <ActionMenuSeparator />
  <ActionMenuItem
    disabled={!canInvite}
    onSelect={() => {
      onInvite(activeSpace);
    }}
  >
    <UserPlusIcon />
    {i18n.t('room.menuInvite')}
  </ActionMenuItem>
  <ActionMenuItem
    onSelect={() => {
      onSettings(activeSpace);
    }}
  >
    <GearIcon />
    {i18n.t('room.menuSettings')}
  </ActionMenuItem>
  <ActionMenuItem
    destructive
    onSelect={() => {
      onLeave(activeSpace);
    }}
  >
    <SignOutIcon />
    {i18n.t('room.menuLeaveSpace')}
  </ActionMenuItem>
{/if}
