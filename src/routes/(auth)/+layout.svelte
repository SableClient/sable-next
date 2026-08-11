<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();

  $effect(() => {
    if (core.status === 'ready') {
      void goto(resolve('/home'));
    }
  });
</script>

{@render children()}
