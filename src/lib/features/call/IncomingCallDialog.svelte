<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { isRecord } from '#lib/guards.js';
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
    roomName: string;
    onAccept: (call: IncomingCall) => void;
    onDecline: (call: IncomingCall) => void;
  }

  let { call, roomName, onAccept, onDecline }: Props = $props();

  const core = useCoreClient();
  let profile = $state.raw<{ name: string; avatar: string | null } | null>(null);
  let senderName = $derived(profile?.name ?? call?.senderName ?? call?.sender ?? '');
  let senderAvatar = $derived(profile?.avatar ?? null);

  $effect(() => {
    const incoming = call;
    profile = null;
    if (!incoming) return;

    let current = true;
    void core.commands.roomStateEvent(incoming.roomId, 'm.room.member', incoming.sender).then(
      (content) => {
        if (!current || !isRecord(content)) return;
        profile = {
          name: typeof content.displayname === 'string' ? content.displayname : incoming.sender,
          avatar: typeof content.avatar_url === 'string' ? content.avatar_url : null,
        };
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  });

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
          {$i18n.t('common.decline')}
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
          {$i18n.t('common.accept')}
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
