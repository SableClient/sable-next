<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
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
    reason = '';
  }
</script>

<ConfirmDialog
  bind:open
  title={$i18n.t('timeline.deleteTitle')}
  description={$i18n.t('timeline.deleteExplain')}
  confirmLabel={$i18n.t('timeline.deleteMessage')}
  cancelLabel={$i18n.t('timeline.cancel')}
  onConfirm={confirm}
  onCancel={cancel}
>
  {#if preview}
    <p class="preview">{preview}</p>
  {/if}
  <FormField fieldId="delete-reason" label={$i18n.t('timeline.deleteReason')}>
    <TextInput id="delete-reason" bind:value={reason} autocomplete="off" />
  </FormField>
</ConfirmDialog>

<style>
  .preview {
    border-inline-start: calc(var(--border-width) * 2) solid var(--crit-main);
    -webkit-box-orient: vertical;
    color: var(--surface-var-on-container);
    display: -webkit-box;
    font-size: var(--font-size-small);
    -webkit-line-clamp: 3;
    line-clamp: 3;
    line-height: 1.45;
    margin: 0;
    overflow: hidden;
    padding-inline-start: var(--space-300);
  }
</style>
