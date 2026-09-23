<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open?: boolean;
    onApply: (href: string) => void;
  }

  let { open = $bindable(false), onApply }: Props = $props();
  let draft = $state('');

  function reset(): void {
    draft = '';
  }

  function apply(): void {
    const href = draft.trim();
    if (href === '') return;

    open = false;
    onApply(href);
    reset();
  }
</script>

<ConfirmDialog
  bind:open
  title={$i18n.t('composer.linkTitle')}
  confirmLabel={$i18n.t('composer.linkApply')}
  confirmVariant="secondary"
  cancelLabel={$i18n.t('composer.linkCancel')}
  onConfirm={apply}
  onCancel={reset}
>
  <FormField fieldId="composer-link-url" label={$i18n.t('composer.linkUrl')}>
    <TextInput id="composer-link-url" bind:value={draft} type="url" autocomplete="off" />
  </FormField>
</ConfirmDialog>
