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
  import TrayIcon from 'phosphor-svelte/lib/TrayIcon';
  import YarnIcon from 'phosphor-svelte/lib/YarnIcon';
  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import ScrollIcon from 'phosphor-svelte/lib/ScrollIcon';
  import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import type { RoomListItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { copyRoomLink, type PermalinkFormat } from '#lib/rooms/permalink.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';

  import RoomNotificationSubmenu from './RoomNotificationSubmenu.svelte';

  interface Props {
    room: RoomListItemView | null;
    canInvite: boolean;
    compact: boolean;
    onMarkRead: () => void;
    onMarkUnread: () => void;
    onInvite: () => void;
    onMembers: () => void;
    onSettings: () => void;
    onJumpToTime?: () => void;
    onClose?: () => void;
    onAttachments?: () => void;
    onThreads?: () => void;
    threadsUnread?: number;
    onCall?: () => void;
    onNotifications?: () => void;
    onPins?: () => void;
    pinsUnread?: number;
    onWidgets?: () => void;
    onRules?: () => void;
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
    onClose,
    onAttachments,
    onThreads,
    threadsUnread = 0,
    onCall,
    onNotifications,
    onPins,
    pinsUnread = 0,
    onWidgets,
    onRules,
    onReport,
    onLeave,
  }: Props = $props();
  const core = useCoreClient();

  let open = $state(false);
  let opened = $state(false);
  let unread = $derived(
    (room?.unread ?? 0) > 0 || (room?.highlight ?? 0) > 0 || (room?.marked_unread ?? false)
  );

  function copyLink(format: PermalinkFormat): void {
    if (!room) return;
    void copyRoomLink(core, room, null, format);
  }
</script>

<ActionMenu
  bind:open
  label={i18n.t('common.moreOptions')}
  class="room-options-menu"
  onOpenChange={(next) => {
    if (next) opened = true;
  }}
>
  {#snippet trigger({ props })}
    <PanelHeaderButton
      {...props}
      class="room-menu-button selection-open"
      label={i18n.t('common.moreOptions')}
    >
      <DotsThreeVerticalIcon />
    </PanelHeaderButton>
  {/snippet}

  <IconContext values={{ 'aria-hidden': 'true' }}>
    {#if unread}
      <ActionMenuItem onSelect={onMarkRead}>
        <ChecksIcon />
        {i18n.t('common.markAsRead')}
      </ActionMenuItem>
    {:else}
      <ActionMenuItem disabled={!room} onSelect={onMarkUnread}>
        <CircleDashedIcon />
        {i18n.t('room.menuMarkUnread')}
      </ActionMenuItem>
    {/if}
    {#if room}
      <RoomNotificationSubmenu roomId={room.room_id} active={opened} />
    {/if}

    <ActionMenuSeparator />

    <ActionMenuItem disabled={!canInvite} onSelect={onInvite}>
      <UserPlusIcon />
      {i18n.t('room.menuInvite')}
    </ActionMenuItem>
    {#if onCall}
      <ActionMenuItem onSelect={onCall}>
        <PhoneIcon />
        {i18n.t((room?.call_participants.length ?? 0) > 0 ? 'call.join' : 'call.start')}
      </ActionMenuItem>
    {/if}
    {#if compact}
      <ActionMenuSeparator />
      <ActionMenuItem onSelect={onMembers}>
        <UserCircleIcon />
        {i18n.t('timeline.members')}
      </ActionMenuItem>
      {#if onThreads}
        <ActionMenuItem onSelect={onThreads}>
          <YarnIcon />
          {#if threadsUnread > 0}
            <span aria-hidden="true">{i18n.t('timeline.threadsOpen')}</span>
            <span class="screen-reader-only"
              >{i18n.t('timeline.threadsUnread', { count: threadsUnread })}</span
            >
            <span class="menu-count" aria-hidden="true">{threadsUnread}</span>
          {:else}
            {i18n.t('timeline.threadsOpen')}
          {/if}
        </ActionMenuItem>
      {/if}
      {#if onNotifications}
        <ActionMenuItem onSelect={onNotifications}>
          <TrayIcon />
          {i18n.t('room.notificationsOpen')}
        </ActionMenuItem>
      {/if}
      {#if onPins}
        <ActionMenuItem onSelect={onPins}>
          <PushPinIcon />
          {i18n.t('room.pinsTitle')}
          {#if pinsUnread > 0}
            <span class="menu-count">{pinsUnread}</span>
          {/if}
        </ActionMenuItem>
      {/if}
      {#if onWidgets}
        <ActionMenuItem onSelect={onWidgets}>
          <GridFourIcon />
          {i18n.t('widgets.label')}
        </ActionMenuItem>
      {/if}
      {#if onAttachments}
        <ActionMenuItem onSelect={onAttachments}>
          <ImagesIcon />
          {i18n.t('timeline.attachmentsTitle')}
        </ActionMenuItem>
      {/if}
      <ActionMenuSeparator />
    {/if}
    {#if onRules}
      <ActionMenuItem onSelect={onRules}>
        <ScrollIcon />
        {i18n.t('room.rulesTitle')}
      </ActionMenuItem>
    {/if}
    <ActionMenuItem onSelect={() => copyLink('matrix')}>
      <LinkIcon />
      {i18n.t('timeline.copyMatrixLink')}
    </ActionMenuItem>
    <ActionMenuItem onSelect={() => copyLink('external')}>
      <LinkIcon />
      {i18n.t('timeline.copyExternalLink')}
    </ActionMenuItem>
    <ActionMenuItem onSelect={onSettings}>
      <GearIcon />
      {i18n.t('room.menuSettings')}
    </ActionMenuItem>
    {#if onJumpToTime}
      <ActionMenuItem onSelect={onJumpToTime}>
        <ClockCounterClockwiseIcon />
        {i18n.t('room.menuJumpToTime')}
      </ActionMenuItem>
    {/if}
    {#if onClose}
      <ActionMenuItem onSelect={onClose}>
        <XIcon />
        {i18n.t('room.menuClose')}
      </ActionMenuItem>
    {/if}

    <ActionMenuSeparator />

    <ActionMenuItem destructive disabled={!room} onSelect={onReport}>
      <FlagIcon />
      {room?.room_kind === 'space' ? i18n.t('room.menuReportSpace') : i18n.t('room.menuReport')}
    </ActionMenuItem>
    <ActionMenuItem destructive onSelect={onLeave}>
      <SignOutIcon />
      {room?.room_kind === 'space' ? i18n.t('room.menuLeaveSpace') : i18n.t('room.menuLeave')}
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
