<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  const core = useCoreClient();
  const userIdPattern = /^@[^:\s]+:\S+$/;

  let userId = $state('');
  let encrypted = $state(true);
  let opening = $state(false);
  let invalid = $state(false);
  let failed = $state(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (opening) return;

    const candidate = userId.trim();
    invalid = !userIdPattern.test(candidate);
    failed = false;
    if (invalid) return;

    opening = true;
    try {
      const roomId = await core.commands.createDm(candidate, encrypted);
      await goto(resolve('/(app)/direct/[roomId]', { roomId: roomPathParamFromId(roomId) }));
    } catch (error) {
      console.warn('[sable direct] could not create a chat', error);
      failed = true;
    } finally {
      opening = false;
    }
  }
</script>

<form class="create-chat" onsubmit={submit}>
  <FormField
    fieldId="create-chat-user"
    label={$i18n.t('direct.userIdLabel')}
    error={invalid ? $i18n.t('common.aUserIdLooksLikeSomeoneserver') : null}
  >
    <TextInput
      id="create-chat-user"
      bind:value={userId}
      autocomplete="off"
      autocapitalize="none"
      spellcheck={false}
      aria-invalid={invalid}
      aria-describedby={invalid ? 'create-chat-user-error' : undefined}
      placeholder={$i18n.t('direct.userIdPlaceholder')}
    />
  </FormField>

  <div class="row">
    <div class="row-text">
      <span class="field-label">{$i18n.t('common.endtoendEncryption')}</span>
      <p class="hint">{$i18n.t('direct.encryptionHint')}</p>
    </div>
    <Switch
      checked={encrypted}
      label={$i18n.t('common.endtoendEncryption')}
      onCheckedChange={(next: boolean) => {
        encrypted = next;
      }}
    />
  </div>

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('direct.failed')}</Alert>
  {/if}

  <Button type="submit" variant="primary" loading={opening} disabled={userId.trim() === ''}>
    {$i18n.t('direct.submit')}
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
