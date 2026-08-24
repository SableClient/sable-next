<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';

  interface Props {
    open?: boolean;
    onReport: (reason: string | null) => void;
  }

  let { open = $bindable(false), onReport }: Props = $props();
  let reason = $state('');
  const fieldId = $props.id();

  function submit(): void {
    open = false;
    onReport(reason.trim() === '' ? null : reason.trim());
    reason = '';
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.reportTitle')}>
  <h2>{$i18n.t('timeline.reportTitle')}</h2>
  <p class="hint">{$i18n.t('timeline.reportReasonHint')}</p>
  <FormField {fieldId} label={$i18n.t('timeline.reportReason')}>
    <TextArea id={fieldId} bind:value={reason} />
  </FormField>
  <FormActions>
    <Button variant="danger" onclick={submit}>{$i18n.t('timeline.reportSend')}</Button>
    <Button
      variant="ghost"
      onclick={() => {
        open = false;
      }}>{$i18n.t('timeline.cancel')}</Button
    >
  </FormActions>
</DialogFrame>

<style>
  h2 {
    font-size: var(--font-size-h4);
    line-height: var(--line-height-h4);
    margin: 0 0 var(--space-200);
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-t300);
    line-height: var(--line-height-t300);
    margin: 0 0 var(--space-400);
  }
</style>
