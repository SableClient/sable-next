<script lang="ts">
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
  import type { NotificationModeView, RoomListItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { notificationModeLabels } from '#lib/rooms/notification-modes.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import {
    setNotificationMode,
    spaceNotifications,
  } from '#lib/rooms/space-notifications.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const roomList = useRoomList();
  const modes: NotificationModeView[] = ['all', 'mentions', 'mute'];

  let custom = $derived(
    spaceNotifications
      .custom(roomList.rooms)
      .map((entry) => ({ ...entry, name: entry.room.display_name }))
      .sort(
        (left, right) =>
          Number(right.room.room_kind === 'space') - Number(left.room.room_kind === 'space') ||
          left.name.localeCompare(right.name)
      )
  );

  function change(room: RoomListItemView, mode: NotificationModeView | null): void {
    setNotificationMode(core, roomList, room, mode).catch((error: unknown) => {
      console.warn('[sable notifications] room mode failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    });
  }
</script>

<section class="settings-form" aria-labelledby="notification-rooms">
  <div class="settings-heading-row">
    <h3 id="notification-rooms" data-settings-outline>{i18n.t('settings.notificationRooms')}</h3>
    <SettingsAnchorLink anchor="notification-rooms" />
  </div>
  <p class="hint settings-description">{i18n.t('settings.notificationRoomsHint')}</p>

  {#if !spaceNotifications.loaded || !roomList.settled}
    <ul
      class="settings-item-list"
      aria-busy="true"
      aria-label={i18n.t('settings.notificationRooms')}
    >
      {#each { length: 3 }, index (index)}
        <li><Skeleton class="room-loading" /></li>
      {/each}
    </ul>
  {:else if custom.length === 0}
    <p class="settings-empty">{i18n.t('settings.notificationRoomsEmpty')}</p>
  {:else}
    <ul class="settings-item-list">
      {#each custom as { room, mode, name } (room.room_id)}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath resolves the route itself -->
          <a class="settings-item-text room" href={roomSectionPath(roomList.rooms, room.room_id)}>
            <Avatar id={room.room_id} src={room.avatar_url} {name} size="small" decorative />
            <span class="name">{name}</span>
            {#if room.room_kind === 'space'}
              <span class="kind">{i18n.t('nav.space')}</span>
            {/if}
          </a>
          <div class="room-controls">
            <Select
              class="settings-item-control"
              forceDropdown
              aria-label={i18n.t('settings.notificationRoomsMode', { room: name })}
              value={mode}
              items={modes.map((option) => ({
                value: option,
                label: i18n.t(notificationModeLabels[option]),
              }))}
              onValueChange={(value) => {
                change(room, value as NotificationModeView);
              }}
            />
            <IconButton
              variant="subtle"
              size="large"
              label={i18n.t('settings.notificationRoomsReset', { room: name })}
              onclick={() => {
                change(room, null);
              }}
            >
              <ArrowCounterClockwiseIcon />
            </IconButton>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .settings-item-list > li {
    flex-wrap: wrap;
  }

  .room {
    align-items: center;
    color: inherit;
    display: flex;
    flex-basis: 12rem;
    gap: var(--space-200);
    text-decoration: none;
  }

  .name {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .room-controls {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    max-width: 100%;
  }

  .room-controls :global(.settings-item-control) {
    flex-shrink: 1;
  }

  .room:hover .name {
    text-decoration: underline;
  }

  .settings-item-list :global(.room-loading) {
    flex: 1;
    height: 2.5rem;
  }

  .kind {
    color: var(--surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
  }
</style>
