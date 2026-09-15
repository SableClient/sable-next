<script lang="ts">
  import type { Snippet } from 'svelte';
  import { smoothSlide } from '../flow/login-transitions';

  interface Props {
    reducedMotion: boolean;
    children: Snippet;
  }

  let { reducedMotion, children }: Props = $props();
</script>

<div class="login-method" transition:smoothSlide={{ duration: reducedMotion ? 0 : 200 }}>
  {@render children()}
</div>

<style>
  .login-method {
    display: grid;
    gap: var(--space-400);
  }
</style>
