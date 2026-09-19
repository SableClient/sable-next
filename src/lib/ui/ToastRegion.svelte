<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { fly } from 'svelte/transition';

  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';
  import { toasts } from './toasts.svelte.js';
  import IconButton from './primitives/IconButton.svelte';

  let { dismissLabel }: { dismissLabel: string } = $props();
</script>

<div class="toast-region">
  {#each toasts.items as toast (toast.id)}
    <div
      class="toast"
      role="alert"
      in:fly={{ y: 8, duration: motionMs(MOTION_MS.slow) }}
      out:fly={{ y: 8, duration: motionMs(MOTION_MS.medium) }}
    >
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
    bottom: calc(var(--space-400) + var(--safe-bottom));
    display: grid;
    gap: var(--space-200);
    max-width: min(28rem, calc(100vw - var(--space-800)));
    pointer-events: none;
    position: fixed;
    right: calc(var(--space-400) + var(--safe-right));
    z-index: var(--layer-notify);
  }

  .toast {
    align-items: center;
    background: var(--crit-container);
    border: var(--border-width) solid var(--crit-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-e300);
    color: var(--crit-on-container);
    display: flex;
    gap: var(--space-300);
    padding: var(--space-200) var(--space-200) var(--space-200) var(--space-300);
    pointer-events: auto;
  }

  .toast span {
    flex: 1;
  }
</style>
