<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { matrixToUrl } from '#lib/rooms/permalink.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import RoomNotificationSubmenu from './RoomNotificationSubmenu.svelte';

  import '#lib/ui/primitives/menu.css';

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

<DropdownMenu.Root
  bind:open
  onOpenChange={(next) => {
    if (next) opened = true;
  }}
>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <IconButton
        {...props}
        class="room-menu-button sable-open"
        variant="ghost"
        size="small"
        label={$i18n.t('room.menuMoreOptions')}
      >
        <DotsThreeVerticalIcon weight={open ? 'fill' : 'regular'} />
      </IconButton>
    {/snippet}
  </DropdownMenu.Trigger>

  <DropdownMenu.Content
    class="sable-menu room-options-menu"
    side="bottom"
    align="end"
    sideOffset={4}
  >
    <IconContext values={{ 'aria-hidden': 'true' }}>
      <DropdownMenu.Item class="sable-menu-item" disabled={!unread} onSelect={onMarkRead}>
        <ChecksIcon />
        {$i18n.t('room.menuMarkRead')}
      </DropdownMenu.Item>
      {#if room && !room.is_space}
        <RoomNotificationSubmenu roomId={room.room_id} active={opened} />
      {/if}

      <DropdownMenu.Separator class="sable-menu-separator" />

      <DropdownMenu.Item class="sable-menu-item" disabled={!canInvite} onSelect={onInvite}>
        <UserPlusIcon />
        {$i18n.t('room.menuInvite')}
      </DropdownMenu.Item>
      {#if compact}
        <DropdownMenu.Item class="sable-menu-item" onSelect={onMembers}>
          <UserCircleIcon />
          {$i18n.t('timeline.members')}
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item class="sable-menu-item" onSelect={copyLink}>
        <LinkIcon />
        {$i18n.t('room.menuCopyLink')}
      </DropdownMenu.Item>
      <DropdownMenu.Item class="sable-menu-item" onSelect={onSettings}>
        <GearIcon />
        {$i18n.t('room.menuSettings')}
      </DropdownMenu.Item>
      <DropdownMenu.Item class="sable-menu-item" onSelect={onJumpToTime}>
        <ClockCounterClockwiseIcon />
        {$i18n.t('room.menuJumpToTime')}
      </DropdownMenu.Item>

      <DropdownMenu.Separator class="sable-menu-separator" />

      <DropdownMenu.Item class="sable-menu-item sable-menu-item-destructive" onSelect={onLeave}>
        <SignOutIcon />
        {room?.is_space ? $i18n.t('room.menuLeaveSpace') : $i18n.t('room.menuLeave')}
      </DropdownMenu.Item>
    </IconContext>
  </DropdownMenu.Content>
</DropdownMenu.Root>
