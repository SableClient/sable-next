<script lang="ts">
  import WebUpdateAlert, { priorityProvider } from './WebUpdateAlert.svelte';

  const provider = priorityProvider();
</script>

{#if provider.priority}
  <WebUpdateAlert {...provider} />
{/if}
