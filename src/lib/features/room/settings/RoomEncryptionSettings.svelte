<script lang="ts">
  import type { RoomPowerLevelsView, RoomSummary } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';

  import { canSendState } from './permission-groups';

  const EVENT_TYPE = 'm.room.encryption';
  const ALGORITHM = 'm.megolm.v1.aes-sha2';

  interface Props {
    room: RoomSummary | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { room, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();

  let confirming = $state(false);
  let enabling = $state(false);
  let failed = $state(false);

  let roomId = $derived(room?.room_id ?? null);
  let enabled = $derived(room?.encrypted === true);
  let canEnable = $derived(canSendState(levels, ownPowerLevel, EVENT_TYPE));

  async function enable(): Promise<void> {
    const target = roomId;
    if (!target || enabling) return;

    enabling = true;
    failed = false;
    try {
      await core.commands.sendStateEvent(target, EVENT_TYPE, '', { algorithm: ALGORITHM });
      confirming = false;
    } catch (error) {
      console.warn('[sable room] enabling encryption failed', error);
      failed = true;
    } finally {
      enabling = false;
    }
  }
</script>

<SettingsRow
  title={$i18n.t('room.encryptionTitle')}
  description={enabled ? $i18n.t('room.encryptionOn') : $i18n.t('room.encryptionOff')}
>
  {#if enabled}
    <StatusBadge variant="success" label={$i18n.t('room.encryptionEnabled')} />
  {:else if canEnable}
    <Button
      size="small"
      onclick={() => {
        confirming = true;
      }}
    >
      {$i18n.t('room.encryptionEnable')}
    </Button>
  {/if}
</SettingsRow>

<ConfirmDialog
  bind:open={confirming}
  title={$i18n.t('room.encryptionEnable')}
  description={$i18n.t('room.encryptionConfirm')}
  confirmLabel={$i18n.t('room.encryptionEnable')}
  confirmVariant="secondary"
  cancelLabel={$i18n.t('room.encryptionCancel')}
  busy={enabling}
  error={failed ? $i18n.t('room.encryptionFailed') : null}
  onConfirm={() => {
    void enable();
  }}
/>
