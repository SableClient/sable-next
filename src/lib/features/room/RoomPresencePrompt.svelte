<script lang="ts">
  import type { PresencePromptView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { presenceSharing } from '#lib/rooms/presence-sharing.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  interface Props {
    roomId: string;
    roomName: string;
  }

  let { roomId, roomName }: Props = $props();
  const core = useCoreClient();

  let prompt = $state.raw<PresencePromptView | null>(null);
  let answering = $state<'share' | 'decline' | null>(null);
  let run = 0;

  $effect(() => {
    const target = roomId;
    void presenceSharing.version;
    const current = ++run;
    prompt = null;
    if (!presenceSharing.supported) return;

    void core.rpc.rooms
      .presencePrompt({ room_id: target })
      .then((next) => {
        if (current === run) prompt = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable presence] presence prompt unavailable', error);
      });
  });

  async function answer(share: boolean): Promise<void> {
    const asked = prompt;
    if (asked === null || answering !== null) return;
    answering = share ? 'share' : 'decline';
    try {
      await core.rpc.rooms.answerPresencePrompt({ prompt: asked, share });
      prompt = null;
    } catch (error) {
      console.warn('[sable presence] presence prompt answer not saved', error);
      toasts.error(i18n.t('errors.actionFailed'));
    } finally {
      answering = null;
    }
  }
</script>

{#if prompt}
  <Alert role="region" aria-label={i18n.t('room.presencePromptLabel')} class="presence-prompt">
    <p>
      {prompt.kind === 'user'
        ? i18n.t('room.presencePromptUser', { name: roomName })
        : i18n.t('room.presencePromptRoom')}
    </p>
    <div class="presence-prompt-actions">
      <Button
        variant="secondary"
        loading={answering === 'decline'}
        disabled={answering !== null}
        onclick={() => void answer(false)}
      >
        {i18n.t('room.presencePromptDecline')}
      </Button>
      <Button
        loading={answering === 'share'}
        disabled={answering !== null}
        onclick={() => void answer(true)}
      >
        {i18n.t('room.presencePromptShare')}
      </Button>
    </div>
  </Alert>
{/if}

<style>
  :global(.presence-prompt) {
    align-items: center;
    display: grid;
    gap: var(--space-300);
    margin: var(--space-300);
  }

  .presence-prompt-actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }

  @media (--app-layout) {
    :global(.presence-prompt) {
      grid-template-columns: 1fr auto;
    }
  }
</style>
