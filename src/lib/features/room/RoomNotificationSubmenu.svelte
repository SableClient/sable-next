<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { NotificationModeView } from '#src/generated/NotificationModeView';

  import { useCoreClient } from '#lib/core/context.js';
  import { settingsChanges } from '#lib/features/notifications/notifications.svelte.js';
  import { i18n } from '#lib/i18n.js';

  interface Props {
    roomId: string;
    active?: boolean;
  }

  let { roomId, active = true }: Props = $props();
  const core = useCoreClient();

  const modes: readonly { mode: NotificationModeView | null; label: string }[] = [
    { mode: null, label: 'room.notifyDefault' },
    { mode: 'all', label: 'room.notifyAll' },
    { mode: 'mentions', label: 'room.notifyMentions' },
    { mode: 'mute', label: 'room.notifyMute' },
  ];
  const modeLabels: Record<NotificationModeView, string> = {
    all: 'room.notifyAll',
    mentions: 'room.notifyMentions',
    mute: 'room.notifyMute',
  };

  let mode = $state<NotificationModeView | null | undefined>();
  let fallback = $state<NotificationModeView | undefined>();
  let defaultLabel = $derived(fallback ? $i18n.t(modeLabels[fallback]) : '');

  $effect(() => {
    void settingsChanges.version;
    if (active) void read();
  });

  async function read(): Promise<void> {
    try {
      const settings = await core.commands.notificationSettings(roomId);
      mode = settings.room;
      fallback = settings.default;
    } catch (error) {
      console.warn('[sable room] notification settings unavailable', error);
    }
  }

  function select(next: NotificationModeView | null): void {
    mode = next;
    void core.commands.setRoomNotificationMode(roomId, next).catch((error: unknown) => {
      console.warn('[sable room] notification mode failed', error);
    });
  }
</script>

<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger class="sable-menu-item">
    <BellIcon />
    {$i18n.t('room.menuNotifications')}
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent class="sable-menu room-options-menu" sideOffset={4}>
    <IconContext values={{ 'aria-hidden': 'true' }}>
      {#each modes as option (option.mode ?? 'default')}
        {@const selected = mode === option.mode}
        <DropdownMenu.Item
          class="sable-menu-item"
          aria-checked={selected}
          onSelect={() => {
            select(option.mode);
          }}
        >
          <span class="sable-menu-check" aria-hidden="true">{selected ? '✓' : ''}</span>
          {$i18n.t(option.label, { mode: defaultLabel })}
        </DropdownMenu.Item>
      {/each}
    </IconContext>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>
