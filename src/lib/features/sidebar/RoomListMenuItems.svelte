<script lang="ts">
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import type { RoomListItemView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { groupsFavourites, setGroupsFavourites } from '#lib/rooms/favourite-grouping.svelte.js';
  import { ROOM_SORTS, ROOM_SORT_LABELS } from '#lib/rooms/room-sort.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import ActionMenuCheckItem from '#lib/ui/primitives/ActionMenuCheckItem.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';

  interface Props {
    activeSpace: RoomListItemView | null;
    favouriteView: string;
    sortKey: 'directSort' | 'roomSort';
    markReadDisabled: boolean;
    onMarkRead: () => void;
    onSettings: (room: RoomListItemView) => void;
    onLeave: (room: RoomListItemView) => void;
  }

  let {
    activeSpace,
    favouriteView,
    sortKey,
    markReadDisabled,
    onMarkRead,
    onSettings,
    onLeave,
  }: Props = $props();

  let groupFavourites = $derived(groupsFavourites(favouriteView));
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
<ActionMenuSeparator />
{#if !activeSpace}
  {#each ROOM_SORTS as option (option)}
    <ActionMenuCheckItem
      checked={preferences[sortKey] === option}
      label={i18n.t(ROOM_SORT_LABELS[option])}
      onSelect={() => {
        setPreference(sortKey, option);
      }}
    />
  {/each}
{:else}
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
