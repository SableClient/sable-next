<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
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

  function apply(event: SubmitEvent): void {
    event.preventDefault();
    const href = draft.trim();
    if (href === '') return;

    open = false;
    onApply(href);
    reset();
  }

  function cancel(): void {
    open = false;
    reset();
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('composer.linkTitle')}>
  <form class="link-dialog" onsubmit={apply}>
    <h2>{$i18n.t('composer.linkTitle')}</h2>
    <FormField fieldId="composer-link-url" label={$i18n.t('composer.linkUrl')}>
      <TextInput id="composer-link-url" bind:value={draft} type="url" autocomplete="off" />
    </FormField>
    <div class="actions">
      <Button type="button" variant="ghost" onclick={cancel}>
        {$i18n.t('composer.linkCancel')}
      </Button>
      <Button type="submit">{$i18n.t('composer.linkApply')}</Button>
    </div>
  </form>
</DialogFrame>

<style>
  .link-dialog {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
