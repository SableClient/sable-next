<script lang="ts">
  import type { Snippet } from 'svelte';

  import { i18n } from '#lib/i18n.js';

  import Alert from './Alert.svelte';
  import Button from './Button.svelte';
  import type { ButtonVariant } from './button-types';
  import DialogActions from './DialogActions.svelte';
  import DialogFrame from './DialogFrame.svelte';

  interface Props {
    open?: boolean;
    title: string;
    description?: string | null;
    confirmLabel: string;
    confirmVariant?: ButtonVariant;
    cancelLabel?: string;
    busy?: boolean;
    error?: string | null;
    onConfirm?: () => void;
    onCancel?: () => void;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
  }

  let {
    open = $bindable(false),
    title,
    description = null,
    confirmLabel,
    confirmVariant = 'danger',
    cancelLabel = $i18n.t('settings.cancel'),
    busy = false,
    error = null,
    onConfirm,
    onCancel,
    onOpenChange,
    children,
  }: Props = $props();

  function cancel(): void {
    open = false;
    onCancel?.();
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
    {@render children?.()}
    {#if error}
      <Alert variant="critical" role="alert">{error}</Alert>
    {/if}
    <DialogActions>
      <Button type="button" variant="ghost" disabled={busy} onclick={cancel}>
        {cancelLabel}
      </Button>
      <Button type="submit" variant={confirmVariant} loading={busy} disabled={busy}>
        {confirmLabel}
      </Button>
    </DialogActions>
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

  .confirm > :global(.dialog-actions) {
    margin-block-start: var(--space-100);
  }
</style>
