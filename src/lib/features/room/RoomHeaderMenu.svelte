<script lang="ts">
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import CircleDashedIcon from 'phosphor-svelte/lib/CircleDashedIcon';
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import type { RoomSummary } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { copyRoomLink } from '#lib/rooms/permalink.js';
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
    onMarkUnread: () => void;
    onInvite: () => void;
    onMembers: () => void;
    onSettings: () => void;
    onJumpToTime: () => void;
    onAttachments?: () => void;
    onLeave: () => void;
  }

  let {
    room,
    canInvite,
    compact,
    onMarkRead,
    onMarkUnread,
    onInvite,
    onMembers,
    onSettings,
    onJumpToTime,
    onAttachments,
    onLeave,
  }: Props = $props();
  const core = useCoreClient();

  let open = $state(false);
  let opened = $state(false);
  let unread = $derived(
    (room?.unread ?? 0) > 0 || (room?.highlight ?? 0) > 0 || (room?.marked_unread ?? false)
  );

  async function copyLink(): Promise<void> {
    if (!room) return;
    if (!(await copyRoomLink(core, room))) toasts.error($i18n.t('errors.copyFailed'));
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
    {#if unread}
      <ActionMenuItem onSelect={onMarkRead}>
        <ChecksIcon />
        {$i18n.t('room.menuMarkRead')}
      </ActionMenuItem>
    {:else}
      <ActionMenuItem disabled={!room} onSelect={onMarkUnread}>
        <CircleDashedIcon />
        {$i18n.t('room.menuMarkUnread')}
      </ActionMenuItem>
    {/if}
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
      {#if onAttachments}
        <ActionMenuItem onSelect={onAttachments}>
          <ImagesIcon />
          {$i18n.t('timeline.attachmentsOpen')}
        </ActionMenuItem>
      {/if}
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
