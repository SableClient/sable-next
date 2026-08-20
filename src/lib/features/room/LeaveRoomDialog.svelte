<script lang="ts">
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  interface Props {
    open: boolean;
    room: RoomSummary | null;
    onOpenChange: (open: boolean) => void;
    onLeft?: (room: RoomSummary) => void;
  }

  let { open, room, onOpenChange, onLeft }: Props = $props();
  const core = useCoreClient();
  let leaving = $state(false);
  let failed = $state(false);

  async function confirm(): Promise<void> {
    const target = room;
    if (!target || leaving) return;

    leaving = true;
    failed = false;
    try {
      await core.leaveRoom(target.room_id);
      onOpenChange(false);
      onLeft?.(target);
    } catch (error) {
      console.warn('[sable room] leave failed', error);
      failed = true;
    } finally {
      leaving = false;
    }
  }
</script>

<DialogFrame {open} {onOpenChange} variant="verification" label={$i18n.t('room.leaveConfirm')}>
  <div class="leave">
    <h2>{$i18n.t('room.leaveTitle', { name: room?.name ?? room?.room_id ?? '' })}</h2>
    <p class="explain">{$i18n.t('room.leaveBody')}</p>
    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('room.leaveFailed')}</Alert>
    {/if}
    <div class="actions">
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}
      >
        {$i18n.t('room.leaveCancel')}
      </Button>
      <Button variant="danger" loading={leaving} onclick={confirm}>
        {$i18n.t('room.leaveConfirm')}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .leave {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }
</style>
