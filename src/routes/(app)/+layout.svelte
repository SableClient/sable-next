<script lang="ts">
  import type { Snippet } from 'svelte';
  import AppShell from '$lib/ui/AppShell.svelte';
  import { useCoreClient } from '$lib/core/context';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();

  $effect(() => {
    if (core.status === 'signed-out' || core.status === 'error') {
      void goto(resolve('/login'));
    }
  });
</script>

{#if core.status === 'ready'}
  <AppShell>
    {@render children()}
  </AppShell>
{/if}
