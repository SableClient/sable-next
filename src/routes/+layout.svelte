<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { Tooltip } from 'bits-ui';
  import '../styles.css';
  import { createCoreClient } from '$lib/core/client.svelte';
  import { provideCoreClient } from '$lib/core/context';
  import favicon from '$lib/assets/favicon.png';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = createCoreClient();
  provideCoreClient(core);

  onMount(() => {
    void core.start();
    return () => {
      core.stop();
    };
  });
</script>

<svelte:head>
  <title>Sable</title>
  <link rel="icon" href={favicon} />
</svelte:head>

<Tooltip.Provider delayDuration={400} skipDelayDuration={100}>
  {@render children()}
</Tooltip.Provider>
