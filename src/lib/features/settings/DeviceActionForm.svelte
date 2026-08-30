<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  type Mode = 'rename' | 'remove';

  interface Props {
    mode: Mode;
    deviceId: string;
    accountManagement?: boolean;
    displayName?: string;
    password?: string;
    onSubmit: () => void;
    onCancel: () => void;
  }

  let {
    mode,
    deviceId,
    accountManagement = false,
    displayName = $bindable(''),
    password = $bindable(''),
    onSubmit,
    onCancel,
  }: Props = $props();
</script>

<form
  class={['device-form', { 'danger-form': mode === 'remove' }]}
  onsubmit={(event) => {
    event.preventDefault();
    onSubmit();
  }}
>
  {#if mode === 'rename'}
    <Label for={`device-${deviceId}`}>{$i18n.t('settings.deviceName')}</Label>
    <TextInput id={`device-${deviceId}`} bind:value={displayName} autofocus required />
    <div class="form-actions">
      <Button type="submit">{$i18n.t('settings.save')}</Button>
      <Button variant="ghost" onclick={onCancel}>{$i18n.t('settings.cancel')}</Button>
    </div>
  {:else}
    <div class="row-copy">
      <strong>{$i18n.t('settings.removeDeviceConfirm')}</strong>
      <p>{$i18n.t('settings.removeDeviceDescription')}</p>
    </div>
    {#if !accountManagement}
      <Label for={`password-${deviceId}`}>{$i18n.t('settings.password')}</Label>
      <TextInput
        id={`password-${deviceId}`}
        type="password"
        bind:value={password}
        autocomplete="current-password"
        autofocus
      />
    {/if}
    <div class="form-actions">
      <Button type="submit" variant="danger">{$i18n.t('settings.removeDevice')}</Button>
      <Button variant="ghost" onclick={onCancel}>{$i18n.t('settings.cancel')}</Button>
    </div>
  {/if}
</form>

<style>
  .device-form {
    background: var(--sable-surface-container);
    border-top: var(--border-width) solid var(--sable-bg-container-line);
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 1fr;
    padding: var(--space-400);
    width: 100%;
  }

  .row-copy {
    min-width: 0;
  }

  .row-copy p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
  }

  .danger-form {
    border-left: var(--border-width-700) solid var(--sable-crit-main);
  }

  .form-actions {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: 1fr 1fr;
  }

  .form-actions :global(.sable-button) {
    width: 100%;
  }

  @media (width >= 42rem) {
    .device-form {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: var(--space-300) var(--space-400);
      width: auto;
    }

    .device-form > :global(.label),
    .danger-form .row-copy {
      grid-column: 1 / -1;
    }

    .form-actions {
      display: flex;
    }

    .form-actions :global(.sable-button) {
      width: auto;
    }
  }
</style>
