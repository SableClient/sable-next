<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open?: boolean;
    preview?: string | null;
    onConfirm: (reason: string | null) => void;
  }

  let { open = $bindable(false), preview = null, onConfirm }: Props = $props();
  let reason = $state('');

  function confirm(): void {
    const trimmed = reason.trim();
    open = false;
    reason = '';
    onConfirm(trimmed.length > 0 ? trimmed : null);
  }

  function cancel(): void {
    open = false;
    reason = '';
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.deleteTitle')}>
  <div class="delete">
    <h2>{$i18n.t('timeline.deleteTitle')}</h2>
    <p class="explain">{$i18n.t('timeline.deleteExplain')}</p>
    {#if preview}
      <p class="preview">{preview}</p>
    {/if}
    <div class="field">
      <FormField fieldId="delete-reason" label={$i18n.t('timeline.deleteReason')}>
        <TextInput id="delete-reason" bind:value={reason} autocomplete="off" />
      </FormField>
    </div>
    <div class="actions">
      <Button variant="ghost" onclick={cancel}>{$i18n.t('timeline.cancel')}</Button>
      <Button variant="danger" onclick={confirm}>{$i18n.t('timeline.deleteMessage')}</Button>
    </div>
  </div>
</DialogFrame>

<style>
  /* `DialogFrame`'s verification variant pads the panel already. */
  .delete {
    display: grid;
    gap: var(--space-2);
    width: min(27rem, 100%);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: 1.3;
    margin: 0;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1.45;
    margin: 0;
  }

  .preview {
    border-inline-start: calc(var(--border-width) * 2) solid var(--sable-crit-main);
    -webkit-box-orient: vertical;
    color: var(--sable-surface-var-on-container);
    display: -webkit-box;
    font-size: var(--font-size-small);
    -webkit-line-clamp: 3;
    line-clamp: 3;
    line-height: 1.45;
    margin: 0;
    overflow: hidden;
    padding-inline-start: var(--space-2);
  }

  .field {
    display: grid;
    gap: 0.25rem;
    margin-block-start: 0.25rem;
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
    margin-block-start: var(--space-1);
  }
</style>
