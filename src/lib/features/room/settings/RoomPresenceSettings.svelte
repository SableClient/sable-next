<script lang="ts">
  import type {
    PresenceHintView,
    RoomPowerLevelsView,
    RoomListItemView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { presenceSharing } from '#lib/rooms/presence-sharing.svelte.js';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { canSendState } from './permission-groups';

  const HINTS: readonly PresenceHintView[] = ['suggest', 'forbid'];

  interface Props {
    room: RoomListItemView | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { room, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();
  const shareId = $props.id();

  let hint = $state<PresenceHintView>('forbid');
  let saving = $state(false);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let eventType = $derived(presenceSharing.view?.hint_event_type ?? null);
  let canEdit = $derived(eventType !== null && canSendState(levels, ownPowerLevel, eventType));
  let options = $derived(
    HINTS.map((value) => ({ value, label: i18n.t(`room.presenceHint.${value}`) }))
  );

  $effect(() => {
    const target = roomId;
    if (!target || !presenceSharing.supported) return;

    const current = ++run;
    void core.rpc.room_state
      .presenceHint({ room_id: target })
      .then((next) => {
        if (current === run) hint = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] presence hint unavailable', error);
      });
  });

  let shared = $derived(roomId !== null && presenceSharing.roomAllowed(roomId));

  function setShared(allowed: boolean): void {
    const target = roomId;
    if (!target) return;
    presenceSharing.edit({ kind: 'room', room_id: target, allowed }).catch((error: unknown) => {
      console.warn('[sable room] presence sharing not changed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    });
  }

  async function select(next: string): Promise<void> {
    const target = roomId;
    const chosen = HINTS.find((entry) => entry === next);
    if (!target || !chosen || saving || chosen === hint) return;

    const previous = hint;
    hint = chosen;
    saving = true;
    try {
      await core.rpc.room_state.setPresenceHint({ room_id: target, hint: chosen });
      presenceSharing.version += 1;
    } catch (error) {
      console.warn('[sable room] presence hint change failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
      hint = previous;
    } finally {
      saving = false;
    }
  }
</script>

{#if presenceSharing.supported}
  <SettingsRow
    title={i18n.t('room.presenceHintTitle')}
    description={i18n.t('room.presenceHintHint')}
  >
    {#if canEdit}
      <Select
        value={hint}
        aria-label={i18n.t('room.presenceHintTitle')}
        disabled={saving}
        items={options}
        onValueChange={(next: string) => {
          void select(next);
        }}
      />
    {:else}
      <span class="value">{i18n.t(`room.presenceHint.${hint}`)}</span>
    {/if}
  </SettingsRow>
  <SettingsRow
    title={i18n.t('room.presenceShareTitle')}
    description={hint === 'forbid'
      ? i18n.t('room.presenceShareForbidden')
      : i18n.t('room.presenceShareHint')}
    disabled={hint === 'forbid'}
    control={shareId}
  >
    <Switch
      id={shareId}
      checked={shared}
      disabled={hint === 'forbid' && !shared}
      label={i18n.t('room.presenceShareTitle')}
      onCheckedChange={setShared}
    />
  </SettingsRow>
{/if}

<style>
  .value {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
