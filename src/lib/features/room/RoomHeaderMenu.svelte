<script lang="ts">
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import type { RoomSummary } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { matrixToUrl } from '#lib/rooms/permalink.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import RoomNotificationSubmenu from './RoomNotificationSubmenu.svelte';

  interface Props {
    room: RoomSummary | null;
    canInvite: boolean;
    compact: boolean;
    onMarkRead: () => void;
    onInvite: () => void;
    onMembers: () => void;
    onSettings: () => void;
    onJumpToTime: () => void;
    onLeave: () => void;
  }

  let {
    room,
    canInvite,
    compact,
    onMarkRead,
    onInvite,
    onMembers,
    onSettings,
    onJumpToTime,
    onLeave,
  }: Props = $props();
  const core = useCoreClient();

  let open = $state(false);
  let opened = $state(false);
  let unread = $derived((room?.unread ?? 0) > 0);

  async function copyLink(): Promise<void> {
    if (!room) return;
    try {
      const via = room.canonical_alias ? [] : await core.commands.roomViaServers(room.room_id);
      await navigator.clipboard.writeText(matrixToUrl(room.canonical_alias ?? room.room_id, via));
    } catch (error) {
      console.debug('[sable room] clipboard unavailable', error);
      toasts.error($i18n.t('errors.copyFailed'));
    }
  }
</script>

<ActionMenu
  bind:open
  label={$i18n.t('room.menuMoreOptions')}
  class="room-options-menu"
  onOpenChange={(next) => {
    if (next) opened = true;
  }}
>
  {#snippet trigger({ props })}
    <IconButton
      {...props}
      class="room-menu-button selection-open"
      variant="ghost"
      size="small"
      label={$i18n.t('room.menuMoreOptions')}
    >
      <DotsThreeVerticalIcon weight={open ? 'fill' : 'regular'} />
    </IconButton>
  {/snippet}

  <IconContext values={{ 'aria-hidden': 'true' }}>
    <ActionMenuItem disabled={!unread} onSelect={onMarkRead}>
      <ChecksIcon />
      {$i18n.t('room.menuMarkRead')}
    </ActionMenuItem>
    {#if room && !room.is_space}
      <RoomNotificationSubmenu roomId={room.room_id} active={opened} />
    {/if}

    <ActionMenuSeparator />

    <ActionMenuItem disabled={!canInvite} onSelect={onInvite}>
      <UserPlusIcon />
      {$i18n.t('room.menuInvite')}
    </ActionMenuItem>
    {#if compact}
      <ActionMenuItem onSelect={onMembers}>
        <UserCircleIcon />
        {$i18n.t('timeline.members')}
      </ActionMenuItem>
    {/if}
    <ActionMenuItem onSelect={copyLink}>
      <LinkIcon />
      {$i18n.t('room.menuCopyLink')}
    </ActionMenuItem>
    <ActionMenuItem onSelect={onSettings}>
      <GearIcon />
      {$i18n.t('room.menuSettings')}
    </ActionMenuItem>
    <ActionMenuItem onSelect={onJumpToTime}>
      <ClockCounterClockwiseIcon />
      {$i18n.t('room.menuJumpToTime')}
    </ActionMenuItem>

    <ActionMenuSeparator />

    <ActionMenuItem destructive onSelect={onLeave}>
      <SignOutIcon />
      {room?.is_space ? $i18n.t('room.menuLeaveSpace') : $i18n.t('room.menuLeave')}
    </ActionMenuItem>
  </IconContext>
</ActionMenu>
