<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { roomPathParamFromId } from '$lib/rooms/room-list.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  const core = useCoreClient();
  const userIdPattern = /^@[^:\s]+:\S+$/;

  let userId = $state('');
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
      const roomId = await core.createDm(candidate);
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
  <div class="field">
    <Label for="create-chat-user">{$i18n.t('direct.userIdLabel')}</Label>
    <TextInput
      id="create-chat-user"
      bind:value={userId}
      autocomplete="off"
      autocapitalize="none"
      spellcheck={false}
      aria-invalid={invalid}
      placeholder={$i18n.t('direct.userIdPlaceholder')}
    />
    {#if invalid}
      <p class="error">{$i18n.t('direct.invalid')}</p>
    {/if}
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
    gap: var(--space-4);
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
