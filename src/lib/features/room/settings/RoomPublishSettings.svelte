<script lang="ts">
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Switch from '#lib/ui/primitives/Switch.svelte';

  import { canSendState } from './permission-groups';

  const CANONICAL_EVENT_TYPE = 'm.room.canonical_alias';

  interface Props {
    room: RoomSummary | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { room, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();

  let published = $state<boolean | null>(null);
  let saving = $state(false);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let joinable = $derived(
    room?.join_rule === 'public' ||
      room?.join_rule === 'knock' ||
      room?.join_rule === 'knock_restricted'
  );
  let canEdit = $derived(canSendState(levels, ownPowerLevel, CANONICAL_EVENT_TYPE) && joinable);

  $effect(() => {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    published = null;
    void core.commands
      .roomDirectoryVisibility(target)
      .then((next) => {
        if (current === run) published = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] directory visibility unavailable', error);
      });
  });

  async function toggle(next: boolean): Promise<void> {
    const target = roomId;
    if (!target || saving) return;

    const previous = published;
    published = next;
    saving = true;
    try {
      await core.commands.setRoomDirectoryVisibility(target, next);
    } catch (error) {
      console.warn('[sable room] directory visibility change failed', error);
      published = previous;
    } finally {
      saving = false;
    }
  }
</script>

{#if published !== null}
  <li class="settings-row">
    <div class="settings-row-copy">
      <span class="settings-row-name">{$i18n.t('room.publishTitle')}</span>
      <p>
        {room?.is_space ? $i18n.t('room.publishSpaceHint') : $i18n.t('room.publishRoomHint')}
      </p>
    </div>
    <div class="settings-row-control">
      {#if canEdit}
        <Switch
          label={$i18n.t('room.publishTitle')}
          checked={published}
          disabled={saving}
          onCheckedChange={(next: boolean) => {
            void toggle(next);
          }}
        />
      {:else}
        <span class="value">
          {published ? $i18n.t('room.publishOn') : $i18n.t('room.publishOff')}
        </span>
      {/if}
    </div>
  </li>
{/if}

<style>
  .value {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
