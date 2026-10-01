<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  let { children }: { children: Snippet } = $props();

  $effect(() => {
    if (!preferences.showHome) {
      void goto(resolve('/(app)/rooms'), { replace: true });
    }
  });
</script>

{#if preferences.showHome}
  {@render children()}
{/if}
