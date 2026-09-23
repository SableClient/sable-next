<script lang="ts">
  import type { RoomSummary } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import type { ShowRoomIcon } from '#lib/settings/preferences.svelte.js';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  import { roomIconOverride, setRoomIconOverride } from './room-appearance.svelte';

  import '#lib/ui/primitives/settings-row.css';

  const DEFAULT = 'default';

  interface Props {
    room: RoomSummary | null;
  }

  let { room }: Props = $props();

  let roomId = $derived(room?.room_id ?? null);
  let value = $derived(roomIconOverride(roomId) ?? DEFAULT);
  let options = $derived([
    {
      value: DEFAULT,
      label: $i18n.t('room.appearanceIconDefault', {
        mode: $i18n.t(`settings.showRoomIcon${label(preferences.showRoomIcon)}`),
      }),
    },
    { value: 'always', label: $i18n.t('settings.showRoomIconAlways') },
    { value: 'sometimes', label: $i18n.t('settings.showRoomIconSometimes') },
    { value: 'collapsed', label: $i18n.t('settings.showRoomIconCollapsed') },
    { value: 'never', label: $i18n.t('settings.showRoomIconNever') },
  ]);

  function label(mode: ShowRoomIcon): string {
    return `${mode.slice(0, 1).toLocaleUpperCase()}${mode.slice(1)}`;
  }

  function select(next: string): void {
    const target = roomId;
    if (!target) return;
    setRoomIconOverride(target, next === DEFAULT ? null : (next as ShowRoomIcon));
  }
</script>

<div class="section">
  <SettingsSection
    headingId="room-settings-appearance"
    title={$i18n.t('room.appearanceVisualTweaks')}
    description={$i18n.t('room.appearanceHint')}
  >
    <ul class="settings-rows">
      <SettingsRow
        title={$i18n.t('room.appearanceIconTitle')}
        description={$i18n.t('room.appearanceIconHint')}
      >
        <Select
          {value}
          aria-label={$i18n.t('room.appearanceIconTitle')}
          items={options}
          onValueChange={select}
        />
      </SettingsRow>
    </ul>
  </SettingsSection>
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }
</style>
