<script lang="ts">
  import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircleIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  interface Props {
    message: string;
    onRetry?: () => void;
    onDismiss: () => void;
  }

  let { message, onRetry, onDismiss }: Props = $props();
</script>

<div class="composer-error" role="alert">
  <span class="composer-error-icon" aria-hidden="true"><WarningCircleIcon weight="fill" /></span>
  <p class="composer-error-text">{message}</p>
  {#if onRetry}
    <Button variant="danger" size="small" class="composer-error-retry" onclick={onRetry}>
      {$i18n.t('common.retry')}
    </Button>
  {/if}
  <IconButton
    variant="ghost"
    size="small"
    class="composer-error-dismiss"
    label={$i18n.t('common.dismiss')}
    onclick={onDismiss}
  >
    <XIcon />
  </IconButton>
</div>

<style>
  .composer-error {
    align-items: center;
    background: var(--crit-container);
    border: var(--border-width) solid var(--crit-container-line);
    border-radius: var(--radius-inner);
    color: var(--crit-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin: var(--space-100) var(--space-100) 0;
    min-width: 0;
    padding: var(--space-050) var(--space-050) var(--space-050) var(--space-200);
  }

  .composer-error-icon {
    display: flex;
    flex: 0 0 auto;
  }

  .composer-error-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .composer-error-text {
    flex: 1;
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .composer-error :global(.composer-error-retry) {
    --button-container: var(--crit-container-hover);
    --button-container-hover: var(--crit-container-active);

    flex: 0 0 auto;
  }

  .composer-error :global(.composer-error-dismiss) {
    --button-on-container: var(--crit-on-container);
    --button-container-hover: var(--crit-container-hover);
    --button-container-active: var(--crit-container-active);

    flex: 0 0 auto;
  }
</style>
