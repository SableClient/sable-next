<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';

  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { CallSession } from './call-session.svelte.js';
  import { callStatusKey } from './call-status';

  interface Props {
    session: CallSession;
    roomName: string;
    onReturn: () => void;
  }

  let { session, roomName, onReturn }: Props = $props();

  let statusLabel = $derived(
    $i18n.t(
      callStatusKey({
        lifecycle: session.lifecycle,
        connection: session.transport.connection,
        mediaReady: session.mediaReady,
      })
    )
  );
</script>

<div class="call-bar">
  <span class="status">{statusLabel}</span>
  <Button variant="ghost" size="small" onclick={onReturn}>
    {$i18n.t('call.returnTo', { room: roomName })}
  </Button>
  <IconButton
    variant="danger"
    size="small"
    label={$i18n.t('call.hangUp')}
    onclick={() => {
      void session.leave();
    }}
  >
    <PhoneDisconnectIcon />
  </IconButton>
</div>

<style>
  .call-bar {
    align-items: center;
    background: var(--sable-surface-container);
    border: var(--space-hairline) solid var(--sable-surface-container-line);
    border-radius: var(--radii-pill);
    box-shadow: var(--sable-shadow);
    display: flex;
    gap: var(--space-150);
    padding: var(--space-100) var(--space-200);
  }

  .status {
    font-size: var(--font-size-small);
  }
</style>
