<script lang="ts">
  import type { Snippet } from 'svelte';
  import { smoothSlide } from '../flow/login-transitions';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="login-method" transition:smoothSlide={{ duration: motionMs(MOTION_MS.fast) }}>
  <div class="login-method-inner">{@render children()}</div>
</div>

<style>
  .login-method {
    display: grid;
    min-height: 0;
  }

  .login-method-inner {
    display: grid;
    gap: var(--space-400);
    min-height: 0;
    overflow: hidden;
  }
</style>
