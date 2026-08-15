<script lang="ts">
  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

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
      <Label for="delete-reason">{$i18n.t('timeline.deleteReason')}</Label>
      <TextInput id="delete-reason" bind:value={reason} autocomplete="off" />
    </div>
    <div class="actions">
      <Button variant="ghost" onclick={cancel}>{$i18n.t('timeline.cancel')}</Button>
      <Button variant="danger" onclick={confirm}>{$i18n.t('timeline.deleteMessage')}</Button>
    </div>
  </div>
</DialogFrame>

<style>
  .delete {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .preview {
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-inline-start: 3px solid var(--sable-crit-main);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    overflow: hidden;
    padding: var(--space-1) var(--space-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .field {
    display: grid;
    gap: 0.25rem;
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }
</style>
