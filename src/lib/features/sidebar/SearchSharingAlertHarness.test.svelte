<script lang="ts">
  import SearchSharingAlert, { priorityProvider } from './SearchSharingAlert.svelte';

  const provider = priorityProvider();
</script>

{#if provider.priority && provider.sharing}
  <SearchSharingAlert
    priority={provider.priority}
    progress={provider.progress}
    sharing={provider.sharing}
    dismiss={provider.dismiss}
    retry={provider.retry}
  />
{/if}
