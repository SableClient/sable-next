<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import SettingsShell, {
    type SettingsShellNav,
  } from '#lib/features/settings/SettingsShell.svelte';
  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import SettingsNav from '#lib/ui/primitives/SettingsNav.svelte';

  import RoomAbbreviationsSettings from './settings/RoomAbbreviationsSettings.svelte';
  import RoomAppearanceSettings from './settings/RoomAppearanceSettings.svelte';
  import RoomCosmeticsSettings from './settings/RoomCosmeticsSettings.svelte';
  import RoomDeveloperSettings from './settings/RoomDeveloperSettings.svelte';
  import RoomEmojiSettings from './settings/RoomEmojiSettings.svelte';
  import RoomGeneralSettings from './settings/RoomGeneralSettings.svelte';
  import RoomMembersSettings from './settings/RoomMembersSettings.svelte';
  import RoomPermissionsSettings from './settings/RoomPermissionsSettings.svelte';
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

  holdOverlayBack(
    () => open && section !== null,
    () => (section = null)
  );

  let roomId = $derived(room?.room_id ?? null);
  let roomName = $derived(room?.name ?? room?.room_id ?? '');
  let ownPowerLevel = $derived(permissions?.own_power_level ?? 0);

  function editable(eventType: string): boolean {
    return levels === null || canSendState(levels, ownPowerLevel, eventType);
  }

  let sections = $derived(
    roomSettingsSections(room?.is_space ?? false).filter((entry) => {
      if (entry.id === 'emojis-stickers') return editable('m.room.image_pack');
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

  function sectionLabel(id: string): string {
    return $i18n.t(sections.find((entry) => entry.id === id)?.label ?? 'room.settingsTitle');
  }
</script>

<DialogFrame {open} {onOpenChange} variant="settings" label={$i18n.t('room.settingsTitle')}>
  <SettingsShell
    {section}
    fallback={() => sections[0]?.id ?? null}
    label={$i18n.t('room.settingsTitle')}
    description={$i18n.t('room.settingsDialogDescription')}
    closeLabel={$i18n.t('room.settingsClose')}
    backLabel={$i18n.t('room.settingsBack')}
    {sectionLabel}
    {heading}
    {nav}
    {content}
    onBack={() => {
      section = null;
    }}
    onClose={close}
  />
</DialogFrame>

{#snippet heading()}
  <span class="room-heading">
    <Avatar id={roomId} src={room?.avatar_url ?? null} name={roomName} size="small" />
    <span class="room-heading-name">{roomName}</span>
  </span>
{/snippet}

{#snippet nav(state: SettingsShellNav)}
  <SettingsNav
    entries={sections.map((entry) => ({ ...entry, label: $i18n.t(entry.label) }))}
    activeId={state.openSection}
    ariaLabel={$i18n.t('room.settingsSections')}
    onSelect={(_, id) => {
      section = id as RoomSettingsSectionId;
    }}
    showChevron={!state.desktop}
    large={!state.desktop}
    current={state.current}
  />
{/snippet}

{#snippet content(active: string)}
  <AppPageShell title={sectionLabel(active)} density="compact" class="room-settings-page">
    {@render page(active as RoomSettingsSectionId)}
  </AppPageShell>
{/snippet}

{#snippet page(active: RoomSettingsSectionId)}
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
  {:else if active === 'cosmetics'}
    <RoomCosmeticsSettings {room} {permissions} {levels} />
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

  .room-heading-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.settings-scroll .app-page-shell.room-settings-page) {
    overflow: visible;
  }
</style>
