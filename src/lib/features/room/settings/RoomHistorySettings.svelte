<script lang="ts">
  import type {
    HistoryVisibilityView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { canSendState } from './permission-groups';

  const EVENT_TYPE = 'm.room.history_visibility';
  const VISIBILITIES: readonly HistoryVisibilityView[] = [
    'shared',
    'invited',
    'joined',
    'world_readable',
  ];

  interface Props {
    room: RoomSummary | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { room, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();

  let visibility = $state<HistoryVisibilityView>('shared');
  let saving = $state(false);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(canSendState(levels, ownPowerLevel, EVENT_TYPE));
  let options = $derived(
    VISIBILITIES.map((value) => ({ value, label: $i18n.t(`room.historyVisibility.${value}`) }))
  );

  $effect(() => {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    void core.commands
      .historyVisibility(target)
      .then((next) => {
        if (current === run) visibility = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] history visibility unavailable', error);
        toasts.error($i18n.t('errors.actionFailed'));
      });
  });

  async function select(next: string): Promise<void> {
    const target = roomId;
    const chosen = VISIBILITIES.find((entry) => entry === next);
    if (!target || !chosen || saving || chosen === visibility) return;

    const previous = visibility;
    visibility = chosen;
    saving = true;
    try {
      await core.commands.setHistoryVisibility(target, chosen);
    } catch (error) {
      console.warn('[sable room] history visibility change failed', error);
      visibility = previous;
    } finally {
      saving = false;
    }
  }
</script>

<SettingsRow title={$i18n.t('room.historyTitle')} description={$i18n.t('room.historyHint')}>
  {#if canEdit}
    <Select
      value={visibility}
      aria-label={$i18n.t('room.historyTitle')}
      disabled={saving}
      items={options}
      onValueChange={(next: string) => {
        void select(next);
      }}
    />
  {:else}
    <span class="value">{$i18n.t(`room.historyVisibility.${visibility}`)}</span>
  {/if}
</SettingsRow>

<style>
  .value {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
