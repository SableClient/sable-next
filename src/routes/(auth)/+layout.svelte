<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { useCoreClient } from '$lib/core/context';
  import AuthFlow from '$lib/features/auth/flow/AuthFlow.svelte';

  let { children }: { children: Snippet } = $props();
  const core = useCoreClient();

  $effect(() => {
    if (
      core.status === 'ready' &&
      !page.url.pathname.startsWith('/register') &&
      !page.url.pathname.startsWith('/login') &&
      !page.url.searchParams.has('addAccount')
    ) {
      void goto(resolve('/home'));
    }
  });
</script>

{#if page.url.pathname.startsWith('/login') || page.url.pathname.startsWith('/register')}
  <AuthFlow />
{/if}
{@render children()}
