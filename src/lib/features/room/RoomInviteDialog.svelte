<script lang="ts">
  import { untrack } from 'svelte';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open: boolean;
    room: RoomSummary | null;
    onOpenChange: (open: boolean) => void;
  }

  let { open, room, onOpenChange }: Props = $props();
  const core = useCoreClient();
  const userIdPattern = /^@[^:\s]+:\S+$/;

  let draft = $state('');
  let invalid = $state(false);
  let inviting = $state(false);
  let invited = $state<string | null>(null);
  let failed = $state(false);
  let convertPrompt = $state(false);
  let converting = $state(false);

  let roomId = $derived(room?.room_id ?? null);
  let isDirect = $derived(room?.is_direct ?? false);

  $effect(() => {
    void roomId;
    if (!open) return;
    untrack(() => {
      draft = '';
      invalid = false;
      invited = null;
      failed = false;
      converting = false;
      convertPrompt = isDirect;
    });
  });

  async function invite(): Promise<void> {
    const target = roomId;
    const candidate = draft.trim();
    if (!target || inviting) return;
    if (!userIdPattern.test(candidate)) {
      invalid = true;
      return;
    }

    invalid = false;
    inviting = true;
    failed = false;
    try {
      await core.commands.inviteUser(target, candidate);
      invited = candidate;
      draft = '';
    } catch (error) {
      console.warn('[sable room] invite failed', error);
      failed = true;
    } finally {
      inviting = false;
    }
  }

  async function convertAndInvite(): Promise<void> {
    const target = roomId;
    if (!target || converting) return;

    converting = true;
    failed = false;
    try {
      await core.commands.setDirect(target, false);
      convertPrompt = false;
    } catch (error) {
      console.warn('[sable room] convert failed', error);
      failed = true;
    } finally {
      converting = false;
    }
  }
</script>

<DialogFrame {open} {onOpenChange} variant="verification" label={$i18n.t('room.inviteTitle')}>
  <div class="invite">
    <h2>{$i18n.t('room.inviteTitle')}</h2>

    {#if convertPrompt}
      <p class="explain">{$i18n.t('room.inviteConvertBody')}</p>
      {#if failed}
        <Alert variant="critical" role="alert">{$i18n.t('room.inviteSendFailed')}</Alert>
      {/if}
      <div class="actions">
        <Button
          variant="ghost"
          onclick={() => {
            onOpenChange(false);
          }}
        >
          {$i18n.t('room.inviteCancel')}
        </Button>
        <Button
          loading={converting}
          onclick={() => {
            void convertAndInvite();
          }}
        >
          {$i18n.t('room.inviteConvertConfirm')}
        </Button>
      </div>
    {:else}
      <p class="explain">
        {$i18n.t('room.inviteBody', { name: room?.name ?? room?.room_id ?? '' })}
      </p>

      <div class="field">
        <Label for="room-invite-user">{$i18n.t('room.createInviteLabel')}</Label>
        <TextInput
          id="room-invite-user"
          bind:value={draft}
          placeholder={$i18n.t('room.createInvitePlaceholder')}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void invite();
          }}
        />
      </div>

      {#if invalid}
        <Alert variant="critical" role="alert">{$i18n.t('room.createInviteInvalid')}</Alert>
      {:else if failed}
        <Alert variant="critical" role="alert">{$i18n.t('room.inviteSendFailed')}</Alert>
      {:else if invited}
        <Alert variant="success" role="status">
          {$i18n.t('room.inviteSent', { user: invited })}
        </Alert>
      {/if}

      <div class="actions">
        <Button
          variant="ghost"
          onclick={() => {
            onOpenChange(false);
          }}
        >
          {$i18n.t('room.inviteClose')}
        </Button>
        <Button
          loading={inviting}
          onclick={() => {
            void invite();
          }}
        >
          {$i18n.t('room.inviteSubmit')}
        </Button>
      </div>
    {/if}
  </div>
</DialogFrame>

<style>
  .invite {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
