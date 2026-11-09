<script lang="ts">
  import type { RoomPowerLevelsView, RoomListItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { loadE2eePolicy } from '#lib/deployment/e2ee-policy.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';

  import RoomKeyExportDialog from './RoomKeyExportDialog.svelte';
  import { canSendState } from './permission-groups';

  const EVENT_TYPE = 'm.room.encryption';

  interface Props {
    room: RoomListItemView | null;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { room, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();

  let confirming = $state(false);
  let enabling = $state(false);
  let failed = $state(false);
  let exportOpen = $state(false);

  let roomId = $derived(room?.room_id ?? null);
  let enabled = $derived(room?.encrypted === true);
  const policy = loadE2eePolicy(core);
  let canEnable = $derived(
    canSendState(levels, ownPowerLevel, EVENT_TYPE) && !policy.current.forceDisabled
  );
  let unencryptedForMe = $derived(room?.encrypted === false && !canEnable);

  async function enable(): Promise<void> {
    const target = roomId;
    if (!target || enabling) return;

    enabling = true;
    failed = false;
    try {
      await core.rpc.room_state.enableEncryption({ room_id: target });
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
  title={i18n.t('common.endToEndEncryption')}
  description={enabled
    ? i18n.t('room.encryptionOn')
    : unencryptedForMe
      ? i18n.t('room.encryptionNotOn')
      : i18n.t('room.encryptionOff')}
>
  {#if enabled}
    <StatusBadge variant="success" label={i18n.t('room.encryptionEnabled')} />
  {:else if unencryptedForMe}
    <StatusBadge variant="warning" label={i18n.t('room.encryptionNotEnabled')} />
  {:else if canEnable}
    <Button
      size="small"
      onclick={() => {
        confirming = true;
      }}
    >
      {i18n.t('room.permEncryption')}
    </Button>
  {/if}
</SettingsRow>

{#if enabled && roomId}
  <SettingsRow title={i18n.t('room.exportKeys')} description={i18n.t('room.exportKeysHint')}>
    <Button
      size="small"
      variant="secondary"
      onclick={() => {
        exportOpen = true;
      }}
    >
      {i18n.t('settings.roomKeysExportAction')}
    </Button>
  </SettingsRow>
  <RoomKeyExportDialog bind:open={exportOpen} {roomId} />
{/if}

<ConfirmDialog
  bind:open={confirming}
  title={i18n.t('room.permEncryption')}
  description={i18n.t('room.encryptionConfirm')}
  confirmLabel={i18n.t('room.permEncryption')}
  confirmVariant="secondary"
  cancelLabel={i18n.t('common.cancel')}
  busy={enabling}
  error={failed ? i18n.t('room.encryptionFailed') : null}
  onConfirm={() => {
    void enable();
  }}
/>
