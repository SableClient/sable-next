<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { parseJoinAddress } from './join-address';

  const core = useCoreClient();
  let address = $state('');
  let joining = $state(false);
  let invalid = $state(false);
  let failed = $state(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (joining) return;

    const parsed = parseJoinAddress(address);
    invalid = parsed === null;
    failed = false;
    if (!parsed) return;

    joining = true;
    try {
      const roomId = await core.commands.joinRoom(parsed.address, parsed.via);
      await goto(resolve('/(app)/rooms/[roomId]', { roomId: roomPathParamFromId(roomId) }));
    } catch (error) {
      console.warn('[sable room] join failed', error);
      failed = true;
    } finally {
      joining = false;
    }
  }
</script>

<form class="join-address" onsubmit={submit}>
  <div class="examples">
    <p>{$i18n.t('room.joinExamplesLabel')}</p>
    <ul>
      <li><code>#room:server</code></li>
      <li><code>https://matrix.to/#/#room:server</code></li>
      <li><code>https://matrix.to/#/!abc:server?via=server</code></li>
    </ul>
  </div>

  <FormField
    fieldId="join-address-input"
    label={$i18n.t('room.joinAddressLabel')}
    error={invalid ? $i18n.t('room.joinInvalid') : null}
  >
    <TextInput
      id="join-address-input"
      bind:value={address}
      autocomplete="off"
      autocapitalize="none"
      spellcheck={false}
      aria-invalid={invalid}
      placeholder={$i18n.t('room.joinAddressPlaceholder')}
    />
  </FormField>

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.joinFailed')}</Alert>
  {/if}

  <Button type="submit" variant="primary" loading={joining} disabled={address.trim() === ''}>
    {$i18n.t('room.joinSubmit')}
  </Button>
</form>

<style>
  .join-address {
    display: grid;
    gap: var(--space-500);
  }

  .examples {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .examples p {
    margin: 0 0 var(--space-200);
  }

  .examples ul {
    display: grid;
    gap: var(--space-050);
    margin: 0;
    padding-left: var(--space-500);
  }
</style>
