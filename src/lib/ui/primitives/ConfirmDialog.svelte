<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  import Button from './Button.svelte';
  import DialogFrame from './DialogFrame.svelte';

  interface Props {
    open?: boolean;
    title: string;
    description?: string | null;
    confirmLabel: string;
    cancelLabel?: string;
    busy?: boolean;
    onConfirm?: () => void;
    onOpenChange?: (open: boolean) => void;
  }

  let {
    open = $bindable(false),
    title,
    description = null,
    confirmLabel,
    cancelLabel = $i18n.t('settings.cancel'),
    busy = false,
    onConfirm,
    onOpenChange,
  }: Props = $props();

  function cancel(): void {
    open = false;
  }
</script>

<DialogFrame
  bind:open
  {onOpenChange}
  variant="verification"
  label={title}
  onConfirm={() => onConfirm?.()}
>
  <div class="confirm">
    <h2>{title}</h2>
    {#if description}
      <p class="explain">{description}</p>
    {/if}
    <div class="actions">
      <Button type="button" variant="ghost" disabled={busy} onclick={cancel}>
        {cancelLabel}
      </Button>
      <Button type="submit" variant="danger" loading={busy} disabled={busy}>
        {confirmLabel}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .confirm {
    display: grid;
    gap: var(--space-300);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: 1.3;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .explain {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1.45;
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
    margin-block-start: var(--space-100);
  }
</style>
