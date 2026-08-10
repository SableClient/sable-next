<script lang="ts">
  import { onMount } from 'svelte';
  import '../styles.css';
  import { createCoreClient } from '$lib/core/client.svelte';
  import { provideCoreClient } from '$lib/core/context';
  import favicon from '$lib/assets/favicon.png';

  let { children } = $props();
  const core = createCoreClient();
  provideCoreClient(core);

  onMount(() => {
    void core.start();
    return () => core.stop();
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
