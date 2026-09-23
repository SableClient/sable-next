<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open?: boolean;
    onApply: (reason: string) => void;
  }

  let { open = $bindable(false), onApply }: Props = $props();
  let draft = $state('');

  function apply(): void {
    open = false;
    onApply(draft.trim());
    draft = '';
  }

  function cancel(): void {
    draft = '';
  }
</script>

<ConfirmDialog
  bind:open
  title={$i18n.t('composer.spoilerTitle')}
  description={$i18n.t('composer.spoilerExplain')}
  confirmLabel={$i18n.t('composer.spoilerApply')}
  confirmVariant="secondary"
  cancelLabel={$i18n.t('composer.linkCancel')}
  onConfirm={apply}
  onCancel={cancel}
>
  <FormField fieldId="composer-spoiler-reason" label={$i18n.t('composer.spoilerReason')}>
    <TextInput id="composer-spoiler-reason" bind:value={draft} autocomplete="off" />
  </FormField>
</ConfirmDialog>
