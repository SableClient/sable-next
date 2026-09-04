<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { toasts } from './toasts.svelte.js';
  import IconButton from './primitives/IconButton.svelte';

  let { dismissLabel }: { dismissLabel: string } = $props();
</script>

<div class="toast-region" aria-live="assertive" aria-relevant="additions">
  {#each toasts.items as toast (toast.id)}
    <div class="toast" role="alert">
      <span>{toast.message}</span>
      <IconButton
        size="small"
        variant="ghost"
        label={dismissLabel}
        onclick={() => toasts.dismiss(toast.id)}
      >
        <XIcon />
      </IconButton>
    </div>
  {/each}
</div>

<style>
  .toast-region {
    bottom: var(--space-400);
    display: grid;
    gap: var(--space-200);
    max-width: min(28rem, calc(100vw - var(--space-800)));
    pointer-events: none;
    position: fixed;
    right: var(--space-400);
    z-index: 100;
  }

  .toast {
    align-items: center;
    background: var(--sable-crit-container);
    border: var(--border-width) solid var(--sable-crit-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-e300);
    color: var(--sable-crit-on-container);
    display: flex;
    gap: var(--space-300);
    padding: var(--space-200) var(--space-200) var(--space-200) var(--space-300);
    pointer-events: auto;
  }

  .toast span {
    flex: 1;
  }
</style>
