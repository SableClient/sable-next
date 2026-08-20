<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { type as osType } from '@tauri-apps/plugin-os';
  import { Tooltip } from 'bits-ui';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import '../styles.css';
  import { createCoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import CoreHealthBanner from '#lib/ui/CoreHealthBanner.svelte';
  import TelemetryConsentBanner from '#lib/ui/TelemetryConsentBanner.svelte';
  import favicon from '#lib/assets/favicon.png';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = createCoreClient();
  provideCoreClient(core);

  onMount(() => {
    if (isTauri()) {
      // CSS keys the keyboard inset off this.
      document.documentElement.dataset.tauriOs = osType();
    }
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

<!-- Icons ride along with a labelled control, so `role="img"` would only add a
     nameless node to the tree. -->
<IconContext values={{ 'aria-hidden': true }}>
  <CoreHealthBanner />
  <TelemetryConsentBanner />

  <Tooltip.Provider delayDuration={400} skipDelayDuration={100}>
    {@render children()}
  </Tooltip.Provider>
</IconContext>
