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
  import { leaveUnlessUnsaved } from '#lib/ui/unsaved-guard.js';

  import RoomAbbreviationsSettings from './RoomAbbreviationsSettings.svelte';
  import RoomAppearanceSettings from './RoomAppearanceSettings.svelte';
  import RoomCosmeticsSettings from './RoomCosmeticsSettings.svelte';
  import RoomDeveloperSettings from './RoomDeveloperSettings.svelte';
  import RoomEmojiSettings from './RoomEmojiSettings.svelte';
  import RoomGeneralSettings from './RoomGeneralSettings.svelte';
  import RoomMembersSettings from './RoomMembersSettings.svelte';
  import RoomPermissionsSettings from './RoomPermissionsSettings.svelte';
  import { roomSettingsSections, type RoomSettingsSectionId } from './room-settings-sections';

  interface Props {
    open: boolean;
    room: RoomSummary | null;
    initialSection?: RoomSettingsSectionId | null;
    onOpenChange: (open: boolean) => void;
  }

  let { open, room, initialSection = null, onOpenChange }: Props = $props();
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
  let sections = $derived(roomSettingsSections(room?.is_space ?? false));

  $effect(() => {
    void roomId;
    if (!open) return;
    untrack(() => {
      section = initialSection;
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
    leaveUnlessUnsaved(() => {
      onOpenChange(false);
    });
  }

  function show(next: RoomSettingsSectionId | null): void {
    leaveUnlessUnsaved(() => {
      section = next;
    });
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
    backLabel={$i18n.t('common.back')}
    {sectionLabel}
    {heading}
    {nav}
    {content}
    onBack={() => {
      show(null);
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
      show(id as RoomSettingsSectionId);
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
