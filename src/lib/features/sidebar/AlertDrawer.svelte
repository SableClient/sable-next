<script lang="ts">
  import { fade, slide } from 'svelte/transition';
  import AlertList, { alertListState } from './AlertList.svelte';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.ts';
  import { cubicOut, linear } from 'svelte/easing';

  function handleKeydown(event: KeyboardEvent) {
    if (!event.defaultPrevented && event.key === 'Escape') {
      alertListState.open = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if alertListState.open}
  <div
    class={['alert-overlay', { open: alertListState.open }]}
    onpointerdown={() => {
      alertListState.open = false;
    }}
    aria-hidden="true"
    role="presentation"
    transition:fade={{ duration: motionMs(MOTION_MS.micro), easing: linear }}
  ></div>
  <div
    class="alert-drawer"
    transition:slide={{ duration: motionMs(MOTION_MS.fast), easing: cubicOut }}
  >
    <AlertList />
  </div>
{/if}

<style>
  .alert-drawer {
    border-right: var(--border-width) solid var(--bg-container-line);
    bottom: 0;
    position: absolute;
    width: 100%;
    z-index: 1;
  }

  .alert-overlay {
    background-color: oklch(from var(--overlay) l c h / 40%);
    inset: 0;
    position: absolute;
  }
</style>
