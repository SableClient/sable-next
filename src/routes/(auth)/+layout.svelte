<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import AuthFlow from '#lib/features/auth/flow/AuthFlow.svelte';
  import { takeAfterLogin } from '#lib/auth/after-login.js';

  let { children }: { children: Snippet } = $props();
  const core = useCoreClient();
  const loginPath = resolve('login');
  const registerPath = resolve('register');
  const setupPath = resolve('setup');
  let authEntry = $derived(
    page.url.pathname.startsWith(loginPath) ||
      page.url.pathname.startsWith(registerPath) ||
      page.url.pathname.startsWith(setupPath)
  );
  let accountSwitching = $state(true);
  let addingAccount = $derived(
    page.url.searchParams.has('addAccount') &&
      (accountSwitching || page.url.searchParams.has('reauth'))
  );

  onMount(() => {
    void runtimeConfig().then((config) => {
      accountSwitching = !config.disableAccountSwitcher;
    });
  });

  $effect(() => {
    if (core.status !== 'ready' || addingAccount) return;
    if (!authEntry || page.url.searchParams.has('addAccount')) {
      void goto(takeAfterLogin(resolve('/(app)/rooms')), { replace: true });
    }
  });
</script>

{#if authEntry}
  <AuthFlow />
{/if}
{@render children()}
