<script lang="ts">
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Select from '#lib/ui/primitives/Select.svelte';

  import { canSendState } from './permission-groups';

  const EVENT_TYPE = 'm.room.history_visibility';
  const VISIBILITIES = ['shared', 'invited', 'joined', 'world_readable'] as const;
  type Visibility = (typeof VISIBILITIES)[number];

  interface Props {
    room: RoomSummary | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { room, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();

  let visibility = $state<Visibility>('shared');
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
    void core
      .roomStateEvent(target, EVENT_TYPE)
      .then((content) => {
        if (current !== run) return;
        visibility = read(content);
      })
      .catch((error: unknown) => {
        console.debug('[sable room] history visibility unavailable', error);
      });
  });

  function read(content: unknown): Visibility {
    if (typeof content !== 'object' || content === null) return 'shared';
    const value = (content as { history_visibility?: unknown }).history_visibility;
    return VISIBILITIES.find((entry) => entry === value) ?? 'shared';
  }

  async function select(next: string): Promise<void> {
    const target = roomId;
    const chosen = VISIBILITIES.find((entry) => entry === next);
    if (!target || !chosen || saving || chosen === visibility) return;

    const previous = visibility;
    visibility = chosen;
    saving = true;
    try {
      await core.sendStateEvent(target, EVENT_TYPE, '', { history_visibility: chosen });
    } catch (error) {
      console.warn('[sable room] history visibility change failed', error);
      visibility = previous;
    } finally {
      saving = false;
    }
  }
</script>

<li class="settings-row">
  <div class="settings-row-copy">
    <span class="settings-row-name">{$i18n.t('room.historyTitle')}</span>
    <p>{$i18n.t('room.historyHint')}</p>
  </div>
  <div class="settings-row-control">
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
  </div>
</li>

<style>
  .value {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
