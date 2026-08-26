<script lang="ts">
  import { untrack } from 'svelte';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import RoomAbbreviationsSettings from './settings/RoomAbbreviationsSettings.svelte';
  import RoomAppearanceSettings from './settings/RoomAppearanceSettings.svelte';
  import RoomDeveloperSettings from './settings/RoomDeveloperSettings.svelte';
  import RoomEmojiSettings from './settings/RoomEmojiSettings.svelte';
  import RoomGeneralSettings from './settings/RoomGeneralSettings.svelte';
  import RoomMembersSettings from './settings/RoomMembersSettings.svelte';
  import RoomPermissionsSettings from './settings/RoomPermissionsSettings.svelte';
  import RoomSettingsShell from './settings/RoomSettingsShell.svelte';
  import {
    roomSettingsSections,
    type RoomSettingsSectionId,
  } from './settings/room-settings-sections';
  import { canSendState } from './settings/permission-groups';

  interface Props {
    open: boolean;
    room: RoomSummary | null;
    onOpenChange: (open: boolean) => void;
  }

  let { open, room, onOpenChange }: Props = $props();
  const core = useCoreClient();

  let permissions = $state<RoomPermissionsView | null>(null);
  let levels = $state<RoomPowerLevelsView | null>(null);
  let section = $state<RoomSettingsSectionId | null>(null);

  let roomId = $derived(room?.room_id ?? null);
  let roomName = $derived(room?.name ?? room?.room_id ?? '');
  let ownPowerLevel = $derived(permissions?.own_power_level ?? 0);

  function editable(eventType: string): boolean {
    return levels === null || canSendState(levels, ownPowerLevel, eventType);
  }

  let sections = $derived(
    roomSettingsSections(room?.is_space ?? false).filter((entry) => {
      if (entry.id === 'emojis-stickers') return editable('im.ponies.room_emotes');
      if (entry.id === 'developer-tools') return editable('m.room.topic');
      return true;
    })
  );

  $effect(() => {
    void roomId;
    if (!open) return;
    untrack(() => {
      section = null;
    });
  });

  $effect(() => {
    const target = roomId;
    if (!open || !target) return;

    let current = true;
    permissions = null;
    levels = null;
    void core.commands
      .roomPermissions(target)
      .then((next) => {
        if (current) permissions = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] permissions unavailable', error);
      });
    void core.commands
      .roomPowerLevels(target)
      .then((next) => {
        if (current) levels = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] power levels unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  function close(): void {
    onOpenChange(false);
  }
</script>

<DialogFrame {open} {onOpenChange} variant="settings" label={$i18n.t('room.settingsTitle')}>
  <RoomSettingsShell
    {section}
    {sections}
    onSelect={(next: RoomSettingsSectionId) => {
      section = next;
    }}
    onBack={() => {
      section = null;
    }}
    onClose={close}
    {header}
    {content}
  />
</DialogFrame>

{#snippet header()}
  <div class="room-heading">
    <Avatar src={room?.avatar_url ?? null} name={roomName} size="small" />
    <span class="room-name">{roomName}</span>
  </div>
{/snippet}

{#snippet content(active: RoomSettingsSectionId)}
  {#if active === 'general'}
    <RoomGeneralSettings {room} {permissions} {levels} onClose={close} />
  {:else if active === 'members'}
    <RoomMembersSettings {room} {permissions} />
  {:else if active === 'permissions'}
    <RoomPermissionsSettings {room} {permissions} />
  {:else if active === 'abbreviations'}
    <RoomAbbreviationsSettings {room} {permissions} {levels} />
  {:else if active === 'appearance'}
    <RoomAppearanceSettings {room} />
  {:else if active === 'emojis-stickers'}
    <RoomEmojiSettings {room} {permissions} {levels} />
  {:else}
    <RoomDeveloperSettings {room} {permissions} {levels} />
  {/if}
{/snippet}

<style>
  .room-heading {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
  }

  .room-name {
    font-size: var(--font-size-h4);
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-h4);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
