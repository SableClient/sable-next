<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { useCoreClient } from '#lib/core/context.js';
  import AuthFlow from '#lib/features/auth/flow/AuthFlow.svelte';

  let { children }: { children: Snippet } = $props();
  const core = useCoreClient();
  const loginPath = resolve('login');
  const registerPath = resolve('register');
  let authEntry = $derived(
    page.url.pathname.startsWith(loginPath) || page.url.pathname.startsWith(registerPath)
  );

  $effect(() => {
    if (core.status === 'ready' && !authEntry && !page.url.searchParams.has('addAccount')) {
      void goto(resolve('/(app)/rooms'), { replaceState: true });
    }
  });
</script>

{#if authEntry}
  <AuthFlow />
{/if}
{@render children()}
