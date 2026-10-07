<script lang="ts">
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import CircleDashedIcon from 'phosphor-svelte/lib/CircleDashedIcon';
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import FlagIcon from 'phosphor-svelte/lib/FlagIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
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
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';

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
    onJumpToTime?: () => void;
    onAttachments?: () => void;
    onThreads?: () => void;
    onPins?: () => void;
    pinsUnread?: number;
    onWidgets?: () => void;
    onReport: () => void;
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
    onThreads,
    onPins,
    pinsUnread = 0,
    onWidgets,
    onReport,
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
  label={$i18n.t('common.moreOptions')}
  class="room-options-menu"
  onOpenChange={(next) => {
    if (next) opened = true;
  }}
>
  {#snippet trigger({ props })}
    <PanelHeaderButton
      {...props}
      class="room-menu-button selection-open"
      label={$i18n.t('common.moreOptions')}
    >
      <DotsThreeVerticalIcon weight={open ? 'fill' : 'regular'} />
    </PanelHeaderButton>
  {/snippet}

  <IconContext values={{ 'aria-hidden': 'true' }}>
    {#if unread}
      <ActionMenuItem onSelect={onMarkRead}>
        <ChecksIcon />
        {$i18n.t('common.markAsRead')}
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
      <ActionMenuSeparator />
      <ActionMenuItem onSelect={onMembers}>
        <UserCircleIcon />
        {$i18n.t('timeline.members')}
      </ActionMenuItem>
      {#if onThreads}
        <ActionMenuItem onSelect={onThreads}>
          <ChatsIcon />
          {$i18n.t('timeline.threadsOpen')}
        </ActionMenuItem>
      {/if}
      {#if onPins}
        <ActionMenuItem onSelect={onPins}>
          <PushPinIcon />
          {$i18n.t('room.pinsTitle')}
          {#if pinsUnread > 0}
            <span class="menu-count">{pinsUnread}</span>
          {/if}
        </ActionMenuItem>
      {/if}
      {#if onWidgets}
        <ActionMenuItem onSelect={onWidgets}>
          <GridFourIcon />
          {$i18n.t('widgets.label')}
        </ActionMenuItem>
      {/if}
      {#if onAttachments}
        <ActionMenuItem onSelect={onAttachments}>
          <ImagesIcon />
          {$i18n.t('timeline.attachmentsTitle')}
        </ActionMenuItem>
      {/if}
      <ActionMenuSeparator />
    {/if}
    <ActionMenuItem onSelect={copyLink}>
      <LinkIcon />
      {$i18n.t('room.menuCopyLink')}
    </ActionMenuItem>
    <ActionMenuItem onSelect={onSettings}>
      <GearIcon />
      {$i18n.t('room.menuSettings')}
    </ActionMenuItem>
    {#if onJumpToTime}
      <ActionMenuItem onSelect={onJumpToTime}>
        <ClockCounterClockwiseIcon />
        {$i18n.t('room.menuJumpToTime')}
      </ActionMenuItem>
    {/if}

    <ActionMenuSeparator />

    <ActionMenuItem destructive disabled={!room} onSelect={onReport}>
      <FlagIcon />
      {room?.is_space ? $i18n.t('room.menuReportSpace') : $i18n.t('room.menuReport')}
    </ActionMenuItem>
    <ActionMenuItem destructive onSelect={onLeave}>
      <SignOutIcon />
      {room?.is_space ? $i18n.t('room.menuLeaveSpace') : $i18n.t('room.menuLeave')}
    </ActionMenuItem>
  </IconContext>
</ActionMenu>

<style>
  .menu-count {
    background: var(--primary-main);
    border-radius: var(--radius-pill);
    color: var(--primary-on-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-600);
    line-height: var(--line-height-small);
    margin-inline-start: auto;
    min-width: var(--size-x400);
    padding: 0 var(--space-150);
    text-align: center;
  }
</style>
