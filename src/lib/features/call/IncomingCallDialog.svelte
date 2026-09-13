<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';

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

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let open = $derived(call !== null);
  let variant = $derived(appLayout.matches ? ('sheet' as const) : ('fullscreen' as const));
</script>

<DialogFrame
  {open}
  {variant}
  label={$i18n.t('call.incomingTitle')}
  onOpenChange={(next: boolean) => {
    if (!next && call) onDecline(call);
  }}
>
  {#if call}
    <div class="incoming" class:incoming-fullscreen={variant === 'fullscreen'}>
      <div class="who">
        <Avatar src={senderAvatar} name={senderName} id={call.sender} size="large" />
        <p class="name">{$i18n.t('call.incomingFrom', { name: senderName })}</p>
        <p class="where">{$i18n.t('call.incomingInRoom', { room: roomName })}</p>
      </div>

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
          {#if call.hasVideo}
            <VideoCameraIcon aria-hidden="true" />
          {:else}
            <PhoneIcon aria-hidden="true" />
          {/if}
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
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
  }

  .name {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .where {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    margin-block-start: var(--space-200);
  }

  .incoming-fullscreen {
    block-size: 100%;
    gap: var(--space-500);
    justify-content: space-between;
    padding-block: var(--space-700);
  }

  .incoming-fullscreen .who {
    flex: 1;
    justify-content: center;
  }

  .incoming-fullscreen .actions {
    inline-size: 100%;
    justify-content: center;
  }
</style>
