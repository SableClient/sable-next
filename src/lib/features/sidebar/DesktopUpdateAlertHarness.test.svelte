<script lang="ts">
  import DesktopUpdateAlert, { priorityProvider } from './DesktopUpdateAlert.svelte';

  const provider = priorityProvider();
</script>

{#if provider.priority}
  <DesktopUpdateAlert {...provider} />
{/if}
