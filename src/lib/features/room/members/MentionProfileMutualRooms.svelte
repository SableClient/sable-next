<script lang="ts">
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import type { MutualRoomView } from '#src/generated/protocol';

  import { goto } from '$app/navigation';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Pill from '#lib/ui/primitives/Pill.svelte';

  interface Props {
    rooms: readonly MutualRoomView[];
    onOpenChange?: (open: boolean) => void;
  }

  let { rooms, onOpenChange }: Props = $props();
  const roomList = useRoomList();

  let sharedRooms = $derived(rooms.filter((room) => !room.is_space));
  let sharedSpaces = $derived(rooms.filter((room) => room.is_space));
  let sharedDirect = $derived(
    sharedRooms.filter((room) => roomList.byId(room.room_id)?.is_direct === true)
  );
  let sharedGroups = $derived(
    sharedRooms.filter((room) => roomList.byId(room.room_id)?.is_direct !== true)
  );
  let label = $derived(i18n.t('timeline.profileMutualRooms', { count: rooms.length }));

  function openRoom(target: string): void {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    void goto(roomSectionPath(roomList.rooms, target));
  }
</script>

{#snippet mutualRows(group: readonly MutualRoomView[])}
  {#each group as room (room.room_id)}
    <ActionMenuItem
      onSelect={() => {
        openRoom(room.room_id);
      }}
    >
      <Avatar
        id={room.room_id}
        src={roomList.byId(room.room_id)?.avatar_url}
        name={room.name ?? room.room_id}
        size="small"
      />
      <span class="profile-mutual-name">{room.name ?? room.room_id}</span>
    </ActionMenuItem>
  {/each}
{/snippet}

{#if sharedRooms.length > 0 || sharedSpaces.length > 0}
  <ActionMenu {label} class="profile-mutual-menu" align="start" {onOpenChange}>
    {#snippet trigger({ props })}
      <Pill {...props}>
        <ChatsIcon size={14} />
        {label}
      </Pill>
    {/snippet}
    {#if sharedSpaces.length > 0}
      {@render mutualRows(sharedSpaces)}
    {/if}
    {#if sharedSpaces.length > 0 && sharedRooms.length > 0}
      <ActionMenuSeparator />
    {/if}
    {@render mutualRows(sharedGroups)}
    {#if sharedGroups.length > 0 && sharedDirect.length > 0}
      <ActionMenuSeparator />
    {/if}
    {@render mutualRows(sharedDirect)}
  </ActionMenu>
{:else}
  <Pill>
    <ChatsIcon size={14} />
    {label}
  </Pill>
{/if}

<style>
  :global(.profile-mutual-menu) {
    --menu-max-height: min(32rem, 80dvh);

    max-width: 300px;
  }

  :global(.profile-mutual-menu .menu-item) {
    --menu-item-padding: var(--control-padding-150);

    min-width: 0;
  }

  :global(.profile-mutual-menu .avatar-root) {
    --avatar-size: var(--avatar-size-200);
  }

  .profile-mutual-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
