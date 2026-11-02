<script lang="ts">
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { NotificationModeView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { settingsChanges } from '#lib/features/notifications/notifications.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { isQuiet, setQuiet } from '#lib/rooms/quiet-rooms.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { notificationModeLabels } from '#lib/rooms/notification-modes.js';
  import {
    setNotificationMode,
    spaceNotifications,
  } from '#lib/rooms/space-notifications.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSub from '#lib/ui/primitives/ActionMenuSub.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  interface Props {
    roomId: string;
    active?: boolean;
  }

  let { roomId, active = true }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  const modes: readonly { mode: NotificationModeView | null; label: string; quiet?: boolean }[] = [
    { mode: null, label: 'room.notifyDefault' },
    { mode: 'all', label: 'room.notifyAll' },
    { mode: 'mentions', label: 'room.notifyMentions' },
    { mode: 'mentions', label: 'room.notifyMentionsQuiet', quiet: true },
    { mode: 'mute', label: 'room.notifyMute' },
  ];
  let roomMode = $state<NotificationModeView | null | undefined>();
  let roomFallback = $state<NotificationModeView>('mentions');
  let isSpace = $derived(roomList.byId(roomId)?.room_kind === 'space');
  let inherited = $derived(
    isSpace ? undefined : spaceNotifications.inherited(roomList.rooms).get(roomId)
  );
  let mode = $derived.by(() => {
    if (isSpace) {
      return spaceNotifications.modeOf(roomId) ?? roomList.byId(roomId)?.notification.room ?? null;
    }
    return inherited !== undefined && roomMode === inherited ? null : roomMode;
  });
  let fallback = $derived(
    isSpace
      ? (roomList.byId(roomId)?.notification.default ?? 'mentions')
      : (inherited ?? roomFallback)
  );
  let defaultQuiet = $derived(
    fallback === 'mentions' &&
      (roomList.byId(roomId)?.is_direct
        ? preferences.badgeDefaultDirect
        : preferences.badgeDefaultGroup) === 'quiet'
  );
  let defaultLabel = $derived(
    i18n.t(defaultQuiet ? 'room.notifyMentionsQuiet' : notificationModeLabels[fallback])
  );

  $effect(() => {
    void settingsChanges.version;
    if (active && !isSpace) void read();
  });

  async function read(): Promise<void> {
    try {
      const settings = await core.rpc.notifications.settings({ room_id: roomId });
      roomMode = settings.room;
      roomFallback = settings.default ?? 'mentions';
    } catch (error) {
      console.warn('[sable room] notification settings unavailable', error);
    }
  }

  function select(next: NotificationModeView | null, quiet = false): void {
    const room = roomList.byId(roomId);
    if (room === undefined) return;
    if (quiet) setQuiet(roomId, true);
    else if (mode === 'mentions' && isQuiet(roomId)) setQuiet(roomId, false);
    if (!isSpace) roomMode = next;
    setNotificationMode(core, roomList.rooms, room, next).catch((error: unknown) => {
      console.warn('[sable room] notification mode failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
      if (!isSpace) void read();
    });
  }
</script>

<ActionMenuSub label={i18n.t('room.menuNotifications')} class="room-options-menu">
  {#snippet trigger()}
    <BellIcon />
    {i18n.t('room.menuNotifications')}
  {/snippet}
  <IconContext values={{ 'aria-hidden': 'true' }}>
    {#each modes as option (option.label)}
      {@const label =
        option.mode === null && inherited !== undefined ? 'room.notifySpace' : option.label}
      {@const selected =
        mode === option.mode && (mode !== 'mentions' || !!option.quiet === isQuiet(roomId))}
      <ActionMenuItem
        checked={selected}
        onSelect={() => {
          select(option.mode, option.quiet);
        }}
      >
        <span class="menu-check" aria-hidden="true">{selected ? '✓' : ''}</span>
        <span>{i18n.t(label, { mode: defaultLabel })}</span>
      </ActionMenuItem>
    {/each}
  </IconContext>
</ActionMenuSub>
