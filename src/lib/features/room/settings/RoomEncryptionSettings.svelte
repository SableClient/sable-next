<script lang="ts">
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
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

<li class="settings-row">
  <div class="settings-row-copy">
    <span class="settings-row-name">{$i18n.t('room.encryptionTitle')}</span>
    <p>{enabled ? $i18n.t('room.encryptionOn') : $i18n.t('room.encryptionOff')}</p>
  </div>
  <div class="settings-row-control">
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
  </div>
</li>

<DialogFrame
  open={confirming}
  onOpenChange={(next: boolean) => {
    confirming = next;
  }}
  variant="verification"
  label={$i18n.t('room.encryptionEnable')}
>
  <div class="confirm">
    <h2>{$i18n.t('room.encryptionEnable')}</h2>
    <p>{$i18n.t('room.encryptionConfirm')}</p>
    {#if failed}
      <p class="error" role="alert">{$i18n.t('room.encryptionFailed')}</p>
    {/if}
    <div class="actions">
      <Button
        variant="ghost"
        disabled={enabling}
        onclick={() => {
          confirming = false;
        }}
      >
        {$i18n.t('room.encryptionCancel')}
      </Button>
      <Button
        loading={enabling}
        onclick={() => {
          void enable();
        }}
      >
        {$i18n.t('room.encryptionEnable')}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .confirm {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .confirm p {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
