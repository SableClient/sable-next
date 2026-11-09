<script lang="ts">
  import type { PriorityProvider } from './alerts';
  import WebUpdateAlert, { priorityProvider } from './WebUpdateAlert.svelte';

  const provider = priorityProvider() as PriorityProvider;
</script>

{#if provider.priority}
  <WebUpdateAlert {...provider} />
{/if}
