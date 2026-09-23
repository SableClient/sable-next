<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { fly } from 'svelte/transition';

  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';
  import { toasts } from './toasts.svelte.js';
  import Button from './primitives/Button.svelte';
  import IconButton from './primitives/IconButton.svelte';

  let { dismissLabel }: { dismissLabel: string } = $props();
</script>

<div class="toast-region">
  {#each toasts.items as toast (toast.id)}
    <div
      class={['toast', `toast-${toast.tone}`]}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      in:fly={{ y: 8, duration: motionMs(MOTION_MS.slow) }}
      out:fly={{ y: 8, duration: motionMs(MOTION_MS.medium) }}
      onpointerenter={() => {
        toasts.hold(toast.id);
      }}
      onpointerleave={() => {
        toasts.release(toast.id);
      }}
      onfocusin={() => {
        toasts.hold(toast.id);
      }}
      onfocusout={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          toasts.release(toast.id);
        }
      }}
    >
      <span>{toast.message}</span>
      {#if toast.action}
        <Button variant="ghost" size="small" onclick={toast.action.run}>{toast.action.label}</Button
        >
      {/if}
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
    border: var(--border-width) solid;
    border-radius: var(--radius);
    box-shadow: var(--shadow-e300);
    display: flex;
    gap: var(--space-300);
    padding: var(--space-200) var(--space-200) var(--space-200) var(--space-300);
    pointer-events: auto;
  }

  .toast-error {
    background: var(--crit-container);
    border-color: var(--crit-container-line);
    color: var(--crit-on-container);
  }

  .toast-info {
    background: var(--success-container);
    border-color: var(--success-container-line);
    color: var(--success-on-container);
  }

  .toast span {
    flex: 1;
  }
</style>
