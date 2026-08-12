<script lang="ts">
  import type { Snippet } from 'svelte';
  import { smoothSlide } from '../flow/login-transitions';

  interface Props {
    divider?: boolean;
    reducedMotion: boolean;
    children: Snippet;
  }

  let { divider = false, reducedMotion, children }: Props = $props();
</script>

<div
  class="login-method"
  class:method-divider={divider}
  transition:smoothSlide={{ duration: reducedMotion ? 0 : 200 }}
>
  {@render children()}
</div>

<style>
  .login-method {
    display: grid;
    gap: 1rem;
  }

  .method-divider {
    border-top: 1px solid var(--sable-surface-container-line);
    padding-top: 1rem;
  }
</style>
