<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { openDirectMessage } from '#lib/core/api/rooms.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { loadE2eePolicy } from '#lib/deployment/e2ee-policy.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { isUserId } from '#lib/guards.js';
  import { parseJoinAddress } from '#lib/rooms/join-address.js';
  import { joinOrKnockPath, joinOrOfferKnock } from '#lib/rooms/join-or-knock.js';
  import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  const core = useCoreClient();

  let address = $state('');
  const policy = loadE2eePolicy(core);
  let encryptedChoice = $state<boolean | null>(null);
  let encrypted = $derived(encryptedChoice ?? policy.current.defaultEncrypted);
  let opening = $state(false);
  let invalid = $state(false);
  let failed = $state(false);
  let room = $derived(parseJoinAddress(address));

  async function open(): Promise<string> {
    if (room) {
      const result = await joinOrOfferKnock(core.rpc, room.address, room.via);
      return joinOrKnockPath(result);
    }
    const roomId = await openDirectMessage(core, address.trim(), encrypted);
    return resolve('/(app)/direct/[roomId]', { roomId: roomPathParamFromId(roomId) });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (opening) return;

    invalid = !room && !isUserId(address.trim());
    failed = false;
    if (invalid) return;

    opening = true;
    try {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- open() resolves the route itself
      await goto(await open());
    } catch (error) {
      console.warn('[sable direct] could not open the chat', error);
      failed = true;
    } finally {
      opening = false;
    }
  }
</script>

<form class="create-chat" onsubmit={submit}>
  <FormField
    fieldId="create-chat-user"
    label={i18n.t('direct.addressLabel')}
    error={invalid ? i18n.t('direct.addressInvalid') : null}
  >
    <TextInput
      id="create-chat-user"
      bind:value={address}
      autocomplete="off"
      autocapitalize="none"
      spellcheck={false}
      aria-invalid={invalid}
      aria-describedby={invalid ? 'create-chat-user-error' : undefined}
      placeholder={i18n.t('direct.addressPlaceholder')}
    />
  </FormField>

  {#if !room && !policy.current.forceDisabled}
    <div class="row">
      <div class="row-text">
        <span class="field-label">{i18n.t('common.endToEndEncryption')}</span>
        <p class="hint">{i18n.t('direct.encryptionHint')}</p>
      </div>
      <Switch
        checked={encrypted}
        label={i18n.t('common.endToEndEncryption')}
        onCheckedChange={(next: boolean) => {
          encryptedChoice = next;
        }}
      />
    </div>
  {/if}

  {#if failed}
    <Alert variant="critical" role="alert">
      {i18n.t(room ? 'common.roomJoinFailed' : 'direct.failed')}
    </Alert>
  {/if}

  <Button type="submit" variant="primary" loading={opening} disabled={address.trim() === ''}>
    {i18n.t(room ? 'common.join' : 'direct.submit')}
  </Button>
</form>

<style>
  .create-chat {
    display: grid;
    gap: var(--space-500);
  }

  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
    justify-content: space-between;
  }

  .row-text {
    display: grid;
    gap: var(--space-100);
    min-width: 0;
  }

  .field-label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }
</style>
