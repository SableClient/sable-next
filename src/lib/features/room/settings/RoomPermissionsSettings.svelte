<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import '#lib/ui/primitives/settings-row.css';

  import {
    levelAt,
    permissionGroups,
    toEventContent,
    withLevel,
    type PermissionLocation,
  } from './permission-groups';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
  }

  let { room, permissions }: Props = $props();
  const core = useCoreClient();

  const namedLevels: readonly { level: number; label: string }[] = [
    { level: 100, label: 'timeline.powerLevelAdmin' },
    { level: 50, label: 'timeline.powerLevelModerator' },
    { level: 0, label: 'timeline.powerLevelMember' },
  ];

  let levels = $state.raw<RoomPowerLevelsView | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let saving = $state(false);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let groups = $derived(permissionGroups(room?.is_space ?? false));
  let canEdit = $derived(permissions?.can_change_power_levels ?? false);

  $effect(() => {
    void roomId;
    void load();
  });

  async function load(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    loading = true;
    failed = false;
    try {
      const loaded = await core.commands.roomPowerLevels(target);
      if (current !== run) return;
      levels = loaded;
    } catch (error) {
      console.warn('[sable room] power levels unavailable', error);
      if (current === run) failed = true;
    } finally {
      if (current === run) loading = false;
    }
  }

  async function setLevel(location: PermissionLocation, level: number): Promise<void> {
    const target = roomId;
    const current = levels;
    if (!target || !current || saving) return;

    const next = withLevel(current, location, level);
    saving = true;
    failed = false;
    try {
      await core.commands.sendStateEvent(target, 'm.room.power_levels', '', toEventContent(next));
      levels = next;
    } catch (error) {
      console.warn('[sable room] permission change failed', error);
      failed = true;
    } finally {
      saving = false;
    }
  }

  function levelLabel(level: number): string {
    const known = namedLevels.find((entry) => entry.level === level);
    return known ? $i18n.t(known.label) : String(level);
  }

  function options(current: number): { value: string; label: string; disabled?: boolean }[] {
    const own = permissions?.own_power_level ?? 0;
    const known = namedLevels.map((entry) => ({
      value: String(entry.level),
      label: $i18n.t(entry.label),
      disabled: entry.level > own,
    }));
    if (known.some((option) => option.value === String(current))) return known;
    return [{ value: String(current), label: String(current) }, ...known];
  }
</script>

<div class="section">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.permFailed')}</Alert>
  {/if}

  {#if loading && levels === null}
    <p class="status" role="status"><Spinner small /></p>
  {:else if levels}
    {#each groups as group (group.label)}
      <SettingsSection headingId={`room-perm-${group.label}`} title={$i18n.t(group.label)}>
        <ul class="settings-rows">
          {#each group.items as item (item.label)}
            {@const level = levelAt(levels, item.location)}
            <li class="settings-row">
              <div class="settings-row-copy">
                <span class="settings-row-name">{$i18n.t(item.label)}</span>
              </div>
              <div class="settings-row-control">
                {#if canEdit && level <= (permissions?.own_power_level ?? 0)}
                  <Select
                    value={String(level)}
                    aria-label={$i18n.t(item.label)}
                    disabled={saving}
                    items={options(level)}
                    onValueChange={(next: string) => {
                      void setLevel(item.location, Number(next));
                    }}
                  />
                {:else}
                  <span class="level">{levelLabel(level)}</span>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </SettingsSection>
    {/each}
  {/if}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-2);
  }

  .status {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-3) 0;
    text-align: center;
  }

  .level {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
