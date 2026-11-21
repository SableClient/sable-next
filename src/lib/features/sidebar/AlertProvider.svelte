<script lang="ts">
  import type { Snippet } from 'svelte';
  import CubeIcon from 'phosphor-svelte/lib/CubeIcon';

  import { provideAlertProviders, type PriorityProvider } from '#lib/features/sidebar/alerts.js';

  let { children }: { children: Snippet } = $props();

  const mockProvider = {
    priority: {
      level: 'critical',
      icon: CubeIcon,
    },
    progress: undefined,
  } satisfies PriorityProvider<unknown>;

  provideAlertProviders([mockProvider]);
</script>

<div>
  {@render children()}
</div>
