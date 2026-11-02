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
  import { roomDisplayName } from '#lib/ui/shortcuts/room-jump.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const roomList = useRoomList();
  const modes: NotificationModeView[] = ['all', 'mentions', 'mute'];

  let custom = $derived(spaceNotifications.custom(roomList.rooms));

  function change(room: RoomListItemView, mode: NotificationModeView | null): void {
    setNotificationMode(core, roomList.rooms, room, mode).catch((error: unknown) => {
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

  {#if custom.length === 0}
    <p class="settings-empty">{i18n.t('settings.notificationRoomsEmpty')}</p>
  {:else}
    <ul class="settings-item-list">
      {#each custom as { room, mode } (room.room_id)}
        {@const name = roomDisplayName(room)}
        <li>
          <span class="settings-item-text">{name}</span>
          <Select
            class="settings-item-control"
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
        </li>
      {/each}
    </ul>
  {/if}
</section>
