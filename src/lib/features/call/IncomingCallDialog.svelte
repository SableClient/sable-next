<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import { senderColor } from '#lib/features/room/timeline-format.js';

  import type { IncomingCall } from './incoming-calls.svelte.js';

  interface Props {
    call: IncomingCall | null;
    senderName: string;
    senderAvatar: string | null;
    roomName: string;
    onAccept: (call: IncomingCall) => void;
    onDecline: (call: IncomingCall) => void;
  }

  let { call, senderName, senderAvatar, roomName, onAccept, onDecline }: Props = $props();

  let open = $derived(call !== null);
</script>

<DialogFrame
  {open}
  variant="sheet"
  label={$i18n.t('call.incomingTitle')}
  onOpenChange={(next: boolean) => {
    if (!next && call) onDecline(call);
  }}
>
  {#if call}
    <div class="incoming">
      <Avatar src={senderAvatar} name={senderName} color={senderColor(call.sender)} size="large" />
      <p class="who">{$i18n.t('call.incomingFrom', { name: senderName })}</p>
      <p class="where">{$i18n.t('call.incomingInRoom', { room: roomName })}</p>

      <div class="actions">
        <Button
          variant="danger"
          onclick={() => {
            onDecline(call);
          }}
        >
          <PhoneDisconnectIcon aria-hidden="true" />
          {$i18n.t('call.decline')}
        </Button>
        <Button
          variant="primary"
          onclick={() => {
            onAccept(call);
          }}
        >
          <PhoneIcon aria-hidden="true" />
          {$i18n.t('call.accept')}
        </Button>
      </div>
    </div>
  {/if}
</DialogFrame>

<style>
  .incoming {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    padding: var(--space-400);
    text-align: center;
  }

  .who {
    font-size: var(--font-size-h4);
    line-height: var(--line-height-h4);
    margin: 0;
  }

  .where {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    margin-block-start: var(--space-200);
  }
</style>
