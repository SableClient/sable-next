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

  interface Option {
    key: string;
    mode: NotificationModeView | null;
    label: string;
    quiet?: boolean;
    exempt?: boolean;
  }

  const explicit: readonly Option[] = [
    { key: 'all', mode: 'all', label: 'room.notifyAll' },
    { key: 'mentions', mode: 'mentions', label: 'room.notifyMentions' },
    { key: 'quiet', mode: 'mentions', label: 'room.notifyMentionsQuiet', quiet: true },
    { key: 'mute', mode: 'mute', label: 'room.notifyMute' },
  ];
  let roomMode = $state<NotificationModeView | null | undefined>();
  let roomFallback = $state<NotificationModeView>('mentions');
  let row = $derived(roomList.byId(roomId));
  let isSpace = $derived(row?.room_kind === 'space');
  let spaceMode = $derived(
    isSpace ? undefined : spaceNotifications.spaceModes(roomList.rooms).get(roomId)
  );
  let exempt = $derived(spaceNotifications.exempt.has(roomId));
  let following = $derived(
    spaceMode !== undefined && !exempt && (roomMode === null || roomMode === spaceMode)
  );
  let mode = $derived.by(() => {
    if (isSpace) return spaceNotifications.modeOf(roomId) ?? row?.notification.room ?? null;
    return following ? null : roomMode;
  });
  let options = $derived<Option[]>([
    ...(spaceMode === undefined ? [] : [{ key: 'space', mode: null, label: 'room.notifySpace' }]),
    { key: 'default', mode: null, label: 'room.notifyDefault', exempt: spaceMode !== undefined },
    ...explicit,
  ]);
  let fallback = $derived(isSpace ? (row?.notification.default ?? 'mentions') : roomFallback);
  let defaultQuiet = $derived(
    fallback === 'mentions' &&
      (row?.is_direct ? preferences.badgeDefaultDirect : preferences.badgeDefaultGroup) === 'quiet'
  );
  let defaultLabel = $derived(
    i18n.t(defaultQuiet ? 'room.notifyMentionsQuiet' : notificationModeLabels[fallback])
  );
  let spaceLabel = $derived(
    spaceMode === undefined ? '' : i18n.t(notificationModeLabels[spaceMode])
  );

  function isSelected(option: Option): boolean {
    if (option.key === 'space') return following;
    if (following) return false;
    if (option.mode === null) return mode === null;
    return mode === option.mode && (mode !== 'mentions' || !!option.quiet === isQuiet(roomId));
  }

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

  function select(option: Option): void {
    const room = row;
    if (room === undefined) return;
    if (option.quiet) setQuiet(roomId, true);
    else if (mode === 'mentions' && isQuiet(roomId)) setQuiet(roomId, false);
    if (!isSpace) roomMode = option.mode;
    const change =
      option.key === 'space' || option.exempt
        ? spaceNotifications.setExempt(room, option.exempt === true)
        : setNotificationMode(core, roomList, room, option.mode);
    change.catch((error: unknown) => {
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
    {#each options as option (option.key)}
      {@const selected = isSelected(option)}
      <ActionMenuItem
        checked={selected}
        onSelect={() => {
          select(option);
        }}
      >
        <span class="menu-check" aria-hidden="true">{selected ? '✓' : ''}</span>
        <span>
          {i18n.t(option.label, { mode: option.key === 'space' ? spaceLabel : defaultLabel })}
        </span>
      </ActionMenuItem>
    {/each}
  </IconContext>
</ActionMenuSub>
