<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open?: boolean;
    onApply: (reason: string) => void;
  }

  let { open = $bindable(false), onApply }: Props = $props();
  let draft = $state('');

  function apply(event: SubmitEvent): void {
    event.preventDefault();
    open = false;
    onApply(draft.trim());
    draft = '';
  }

  function cancel(): void {
    open = false;
    draft = '';
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('composer.spoilerTitle')}>
  <form class="spoiler-dialog" onsubmit={apply}>
    <h2>{$i18n.t('composer.spoilerTitle')}</h2>
    <p>{$i18n.t('composer.spoilerExplain')}</p>
    <FormField fieldId="composer-spoiler-reason" label={$i18n.t('composer.spoilerReason')}>
      <TextInput id="composer-spoiler-reason" bind:value={draft} autocomplete="off" />
    </FormField>
    <div class="actions">
      <Button type="button" variant="ghost" onclick={cancel}>
        {$i18n.t('composer.linkCancel')}
      </Button>
      <Button type="submit">{$i18n.t('composer.spoilerApply')}</Button>
    </div>
  </form>
</DialogFrame>

<style>
  .spoiler-dialog {
    display: grid;
    gap: var(--space-400);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  p {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
